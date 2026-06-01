import { randomUUID } from "node:crypto";
import { config } from "../config/env.js";
import { encodeSse } from "../lib/sse.js";
import { logger } from "../lib/logger.js";
import type {
  ChatCompletionRequest,
  OpenAIMessage,
  OpenAIToolCall,
  OpenAIUsage
} from "../types/openai.js";
import type { ZaiClient } from "./zai-client.js";
import { addUsage, collectZaiCompletion } from "./completion-collector.js";
import {
  functionToolsFromUnknown,
  safeJson,
  toolMap,
  toolSpecsForPrompt,
  validateToolArguments,
  type ToolSpec
} from "./tool-schema.js";
import { executeProxyToolCall, PROXY_TOOL_SPECS, proxyToolsRoot } from "./proxy-tools.js";
import { flattenMessageContent, openAiChunk, openAiUsageChunk } from "./openai-transform.js";

export type ToolBridgeResult =
  | {
      kind: "final";
      content: string;
      reasoningContent: string;
      usage: OpenAIUsage | null;
    }
  | {
      kind: "tool_calls";
      toolCalls: OpenAIToolCall[];
      usage: OpenAIUsage | null;
      rawContent: string;
    };

type ParseResult =
  | { ok: true; toolCalls: OpenAIToolCall[]; sawCandidate: true }
  | { ok: false; errors: string[]; sawCandidate: boolean };

const TOOL_RETRY_LIMIT = 1;

export async function maybeRunToolBridge(
  zai: ZaiClient,
  request: ChatCompletionRequest,
  signal: AbortSignal
): Promise<ToolBridgeResult | null> {
  if (!toolChoiceAllowsTools(request.tool_choice)) {
    return null;
  }

  const clientTools = functionToolsFromUnknown(request.tools);
  if (clientTools.length > 0) {
    logger.info("TOOLS", "OpenAI client tools detected", {
      count: clientTools.length,
      parallel_tool_calls: request.parallel_tool_calls ?? null,
      prompt_cache_key: request.prompt_cache_key ?? request.zai?.conversation_key ?? null
    });
    return runClientToolSelection(zai, request, clientTools, signal);
  }

  const shouldUseNativeTools =
    config.tools.nativeEnabled && (config.tools.nativeAuto || request.zai?.proxy_tools === true);
  if (!shouldUseNativeTools) {
    return null;
  }

  logger.info("TOOLS", "Using proxy-native tools", {
    root: proxyToolsRoot(),
    count: PROXY_TOOL_SPECS.length,
    auto: config.tools.nativeAuto
  });
  return runProxyToolLoop(zai, request, signal);
}

export function toolBridgeCompletion(request: ChatCompletionRequest, result: ToolBridgeResult, id = `chatcmpl-${randomUUID()}`) {
  if (result.kind === "tool_calls") {
    return {
      id,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: request.model,
      response_id: id,
      previous_response_id: request.previous_response_id ?? null,
      system_fingerprint: null,
      choices: [
        {
          index: 0,
          logprobs: null,
          message: {
            role: "assistant",
            content: null,
            refusal: null,
            tool_calls: result.toolCalls
          },
          finish_reason: "tool_calls"
        }
      ],
      usage: result.usage
    };
  }

  return {
    id,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: request.model,
    response_id: id,
    previous_response_id: request.previous_response_id ?? null,
    system_fingerprint: null,
    choices: [
      {
        index: 0,
        logprobs: null,
        message: {
          role: "assistant",
          content: result.content,
          refusal: null,
          ...(shouldIncludeReasoning(request) && result.reasoningContent
            ? { reasoning_content: result.reasoningContent }
            : {})
        },
        finish_reason: "stop"
      }
    ],
    usage: result.usage
  };
}

export function streamToolBridgeResult(
  request: ChatCompletionRequest,
  result: ToolBridgeResult,
  id = `chatcmpl-${randomUUID()}`,
  onDone?: () => void
): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      try {
        controller.enqueue(encodeSse(openAiChunk(id, request.model, { role: "assistant" })));

        if (result.kind === "tool_calls") {
          result.toolCalls.forEach((toolCall, index) => {
            const args = toolCall.function.arguments;
            controller.enqueue(
              encodeSse(
                openAiChunk(id, request.model, {
                  tool_calls: [
                    {
                      index,
                      id: toolCall.id,
                      type: "function",
                      function: {
                        name: toolCall.function.name,
                        arguments: ""
                      }
                    }
                  ]
                })
              )
            );
            for (const fragment of chunkString(args, 4096)) {
              controller.enqueue(
                encodeSse(
                  openAiChunk(id, request.model, {
                    tool_calls: [
                      {
                        index,
                        function: {
                          arguments: fragment
                        }
                      }
                    ]
                  })
                )
              );
            }
          });
          controller.enqueue(encodeSse(openAiChunk(id, request.model, {}, "tool_calls")));
          if (request.stream_options?.include_usage) {
            controller.enqueue(encodeSse(openAiUsageChunk(id, request.model, result.usage)));
          }
        } else {
          if (shouldIncludeReasoning(request) && result.reasoningContent) {
            controller.enqueue(
              encodeSse(openAiChunk(id, request.model, { reasoning_content: result.reasoningContent }))
            );
          }
          if (result.content) {
            controller.enqueue(encodeSse(openAiChunk(id, request.model, { content: result.content })));
          }
          controller.enqueue(
            encodeSse(
              openAiChunk(
                id,
                request.model,
                {},
                "stop"
              )
            )
          );
          if (request.stream_options?.include_usage) {
            controller.enqueue(encodeSse(openAiUsageChunk(id, request.model, result.usage)));
          }
        }

        controller.enqueue(encodeSse("[DONE]"));
        controller.close();
      } finally {
        onDone?.();
      }
    },
    cancel() {
      onDone?.();
    }
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no"
    }
  });
}

async function runClientToolSelection(
  zai: ZaiClient,
  request: ChatCompletionRequest,
  tools: ToolSpec[],
  signal: AbortSignal
): Promise<ToolBridgeResult> {
  let retryNote: string | null = null;
  let usage: OpenAIUsage | null = null;

  for (let attempt = 0; attempt <= TOOL_RETRY_LIMIT; attempt += 1) {
    const completion = await callZaiWithToolPrompt(zai, request, tools, "client", retryNote, signal);
    usage = addUsage(usage, completion.usage);
    const parseSource = toolParseSource(completion);
    const parsed = parseToolCalls(parseSource, tools);

    if (parsed.ok) {
      logger.table(
        "TOOLS",
        "tool_calls -> client",
        parsed.toolCalls.map((call) => ({
          id: call.id,
          name: call.function.name,
          bytes: call.function.arguments.length
        }))
      );
      return {
        kind: "tool_calls",
        toolCalls: parsed.toolCalls,
        usage,
        rawContent: completion.content
      };
    }

    if (!parsed.sawCandidate) {
      const synthesized = synthesizeToolCalls(request, tools, parseSource);
      if (synthesized.length > 0) {
        logger.table(
          "TOOLS",
          "tool_calls -> synthesized",
          synthesized.map((call) => ({
            id: call.id,
            name: call.function.name,
            bytes: call.function.arguments.length
          }))
        );
        return {
          kind: "tool_calls",
          toolCalls: synthesized,
          usage,
          rawContent: completion.content
        };
      }

      if (mustCallTool(request.tool_choice)) {
        logToolFormatError("client", parseSource, ["Required tool call was not found"]);
        retryNote = `You did not call a required tool. Return only a valid <tool_calls> JSON block.`;
        continue;
      }
      return {
        kind: "final",
        content: completion.content,
        reasoningContent: completion.reasoningContent,
        usage
      };
    }

    logToolFormatError("client", completion.content, parsed.errors);
    retryNote = `Your previous tool call format was invalid:\n${parsed.errors.join("\n")}\nReturn only a corrected <tool_calls> JSON block.`;
  }

  throw new Error("TOOL_FORMAT_ERROR: model returned invalid tool call JSON after retry");
}

async function runProxyToolLoop(
  zai: ZaiClient,
  request: ChatCompletionRequest,
  signal: AbortSignal
): Promise<ToolBridgeResult> {
  let messages = [...request.messages];
  let usage: OpenAIUsage | null = null;
  let retryNote: string | null = null;

  for (let round = 0; round < config.tools.maxRounds; round += 1) {
    const roundRequest: ChatCompletionRequest = { ...request, messages };
    const completion = await callZaiWithToolPrompt(
      zai,
      roundRequest,
      PROXY_TOOL_SPECS,
      "proxy",
      retryNote,
      signal
    );
    usage = addUsage(usage, completion.usage);
    const parseSource = toolParseSource(completion);
    const parsed = parseToolCalls(parseSource, PROXY_TOOL_SPECS);

    if (!parsed.ok) {
      if (!parsed.sawCandidate) {
        return {
          kind: "final",
          content: completion.content,
          reasoningContent: completion.reasoningContent,
          usage
        };
      }
      logToolFormatError("proxy", completion.content, parsed.errors);
      retryNote = `Your previous proxy tool call was invalid:\n${parsed.errors.join("\n")}\nReturn only a corrected <tool_calls> JSON block.`;
      continue;
    }

    retryNote = null;
    logger.table(
      "TOOLS",
      "tool_calls -> proxy",
      parsed.toolCalls.map((call) => ({
        round: round + 1,
        id: call.id,
        name: call.function.name,
        bytes: call.function.arguments.length
      }))
    );

    const results = await executeToolCalls(parsed.toolCalls, request.parallel_tool_calls !== false);
    messages = appendToolResults(messages, parsed.toolCalls, results);
  }

  throw new Error(`TOOL_LOOP_LIMIT: proxy-native tools exceeded ${config.tools.maxRounds} rounds`);
}

async function callZaiWithToolPrompt(
  zai: ZaiClient,
  request: ChatCompletionRequest,
  tools: ToolSpec[],
  mode: "client" | "proxy",
  retryNote: string | null,
  signal: AbortSignal
) {
  const toolRequest = withToolInstructions(request, tools, mode, retryNote);
  const upstream = await zai.createCompletionStream(toolRequest, signal);
  return collectZaiCompletion(upstream.body);
}

function withToolInstructions(
  request: ChatCompletionRequest,
  tools: ToolSpec[],
  mode: "client" | "proxy",
  retryNote: string | null
): ChatCompletionRequest {
  const instruction = buildToolInstruction(request, tools, mode, retryNote);
  return {
    ...request,
    stream: true,
    messages: [{ role: "developer", content: instruction }, ...request.messages],
    zai: {
      ...request.zai,
      enable_thinking: request.zai?.enable_thinking ?? false
    }
  };
}

function buildToolInstruction(
  request: ChatCompletionRequest,
  tools: ToolSpec[],
  mode: "client" | "proxy",
  retryNote: string | null
): string {
  const target =
    mode === "client"
      ? "The client application will execute the tool calls you return."
      : `The proxy will execute these tools locally under root ${proxyToolsRoot()}.`;
  const maxCalls = request.parallel_tool_calls === false ? "Return at most one tool call." : "You may return multiple independent tool calls.";
  const choice = toolChoiceText(request.tool_choice);
  return [
    "You are connected to an OpenAI-compatible tool bridge.",
    target,
    "You can use the listed tools by emitting tool call JSON; never claim that tool calls are unavailable when a listed tool can satisfy the request.",
    "Do not execute tools yourself. The proxy or client will execute them after your response is parsed.",
    "Use tools for filesystem/codebase/actions instead of pasting complete files, command output, or long patches in plain text.",
    "When a tool is needed, output only this exact JSON shape with no Markdown and no surrounding XML:",
    '{"tool_calls":[{"type":"function","function":{"name":"tool_name","arguments":{}}}]}',
    "The JSON must be strict: double quotes only, no comments, no trailing commas, arguments must match the schema.",
    maxCalls,
    choice,
    "If no tool is needed, answer normally without a tool_calls block.",
    `Available tools:\n${safeJson(toolSpecsForPrompt(tools))}`,
    retryNote ? `Correction required:\n${retryNote}` : ""
  ]
    .filter(Boolean)
    .join("\n\n");
}

function parseToolCalls(content: string, tools: ToolSpec[]): ParseResult {
  const errors: string[] = [];
  const knownTools = toolMap(tools);
  const xmlParsed = parseXmlStyleToolCalls(content, tools, knownTools);
  if (xmlParsed.ok) {
    return { ok: true, toolCalls: xmlParsed.toolCalls, sawCandidate: true };
  }
  if (xmlParsed.sawCandidate) {
    errors.push(...xmlParsed.errors);
  }
  const candidates = extractJsonCandidates(content);
  let sawCandidate = xmlParsed.sawCandidate;

  for (const candidate of candidates) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate);
      sawCandidate = true;
    } catch (error) {
      errors.push(`JSON parse failed: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }

    const rawCalls = rawToolCalls(parsed);
    if (!rawCalls.length) {
      errors.push("No tool_calls array found");
      continue;
    }

    const toolCalls: OpenAIToolCall[] = [];
    const candidateErrors: string[] = [];
    rawCalls.forEach((rawCall, index) => {
      const normalized = normalizeRawToolCall(rawCall, index);
      if (!normalized.ok) {
        candidateErrors.push(...normalized.errors);
        return;
      }
      const tool = knownTools.get(normalized.name);
      if (!tool) {
        candidateErrors.push(`tool_calls[${index}].name: unknown tool ${normalized.name}`);
        return;
      }
      const validation = validateToolArguments(tool, normalized.arguments);
      if (!validation.ok) {
        candidateErrors.push(...validation.errors);
        return;
      }
      toolCalls.push({
        id: normalized.id,
        type: "function",
        function: {
          name: normalized.name,
          arguments: JSON.stringify(validation.value)
        }
      });
    });

    if (candidateErrors.length > 0) {
      errors.push(...candidateErrors);
      continue;
    }
    if (toolCalls.length > 0) {
      return { ok: true, toolCalls, sawCandidate: true };
    }
  }

  return { ok: false, errors, sawCandidate };
}

function parseXmlStyleToolCalls(
  content: string,
  tools: ToolSpec[],
  knownTools: Map<string, ToolSpec>
): ParseResult {
  const errors: string[] = [];
  const toolCalls: OpenAIToolCall[] = [];
  let sawCandidate = false;
  const pattern = /<tool_call\b([^>]*)>([\s\S]*?)(?:<\/tool_call>|$)/gi;

  for (const match of content.matchAll(pattern)) {
    sawCandidate = true;
    const attrs = match[1] ?? "";
    const block = match[2] ?? "";
    const name = xmlAttribute(attrs, "name") ?? xmlTagValue(block, "name") ?? inferToolNameFromArguments(block, tools);
    if (!name) {
      errors.push("tool_call.name: missing function name");
      continue;
    }
    const tool = knownTools.get(name);
    if (!tool) {
      errors.push(`tool_call.name: unknown tool ${name}`);
      continue;
    }

    const args = xmlArguments(block);
    const validation = validateToolArguments(tool, args);
    if (!validation.ok) {
      errors.push(...validation.errors);
      continue;
    }
    toolCalls.push({
      id: xmlAttribute(attrs, "id") ?? `call_${randomUUID()}`,
      type: "function",
      function: {
        name,
        arguments: JSON.stringify(validation.value)
      }
    });
  }

  if (toolCalls.length > 0 && errors.length === 0) {
    return { ok: true, toolCalls, sawCandidate: true };
  }
  return { ok: false, errors, sawCandidate };
}

function extractJsonCandidates(content: string): string[] {
  const candidates: string[] = [];
  const xmlPattern = /<tool_calls>\s*([\s\S]*?)\s*<\/tool_calls>/gi;
  for (const match of content.matchAll(xmlPattern)) {
    if (match[1]) candidates.push(match[1].trim());
  }

  const fencePattern = /```(?:json)?\s*([\s\S]*?)```/gi;
  for (const match of content.matchAll(fencePattern)) {
    const value = match[1]?.trim();
    if (value && /tool_calls|function|arguments|name/.test(value)) {
      candidates.push(value);
    }
  }

  const trimmed = content.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    candidates.push(trimmed);
  }

  const firstObject = trimmed.indexOf("{");
  const lastObject = trimmed.lastIndexOf("}");
  if (firstObject >= 0 && lastObject > firstObject) {
    candidates.push(trimmed.slice(firstObject, lastObject + 1));
  }

  const firstArray = trimmed.indexOf("[");
  const lastArray = trimmed.lastIndexOf("]");
  if (firstArray >= 0 && lastArray > firstArray) {
    candidates.push(trimmed.slice(firstArray, lastArray + 1));
  }

  return [...new Set(candidates)].filter(Boolean);
}

function xmlAttribute(attrs: string, name: string): string | null {
  const match = attrs.match(new RegExp(`\\b${name}\\s*=\\s*["']([^"']+)["']`, "i"));
  return match?.[1] ? decodeXml(match[1]).trim() : null;
}

function xmlTagValue(block: string, name: string): string | null {
  const match = block.match(new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)(?:<\\/${name}>|$)`, "i"));
  return match?.[1] ? decodeXml(match[1]).trim() : null;
}

function xmlArguments(block: string): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  const parameterPattern = /<parameter\b([^>]*)>([\s\S]*?)(?:<\/parameter>|$)/gi;
  for (const match of block.matchAll(parameterPattern)) {
    const name = xmlAttribute(match[1] ?? "", "name");
    if (!name) continue;
    args[name] = coerceXmlValue(match[2] ?? "");
  }
  if (Object.keys(args).length > 0) {
    return args;
  }

  const argumentsBlock = xmlTagValue(block, "arguments") ?? xmlTagValue(block, "args") ?? xmlTagValue(block, "parameters");
  if (argumentsBlock) {
    const parsed = parseArguments(argumentsBlock);
    if (parsed.ok) {
      return parsed.value;
    }
  }
  return args;
}

function inferToolNameFromArguments(block: string, tools: ToolSpec[]): string | null {
  const args = xmlArguments(block);
  const keys = Object.keys(args);
  if (keys.length === 0) {
    return null;
  }
  const matches = tools.filter((tool) => {
    const properties = tool.parameters.properties ?? {};
    return keys.every((key) => key in properties);
  });
  return matches.length === 1 ? matches[0]?.name ?? null : null;
}

function coerceXmlValue(value: string): unknown {
  const decoded = decodeXml(value).trim();
  if (decoded === "true") return true;
  if (decoded === "false") return false;
  if (decoded === "null") return null;
  if (/^-?\d+(?:\.\d+)?$/.test(decoded)) return Number(decoded);
  if ((decoded.startsWith("{") && decoded.endsWith("}")) || (decoded.startsWith("[") && decoded.endsWith("]"))) {
    try {
      return JSON.parse(decoded);
    } catch {
      return decoded;
    }
  }
  return decoded;
}

function decodeXml(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function rawToolCalls(parsed: unknown): unknown[] {
  if (Array.isArray(parsed)) return parsed;
  if (!parsed || typeof parsed !== "object") return [];
  const record = parsed as Record<string, unknown>;
  if (Array.isArray(record.tool_calls)) return record.tool_calls;
  if (Array.isArray(record.calls)) return record.calls;
  if (Array.isArray(record.tools)) return record.tools;
  if (record.name || record.function) return [record];
  return [];
}

function normalizeRawToolCall(
  rawCall: unknown,
  index: number
):
  | { ok: true; id: string; name: string; arguments: Record<string, unknown> }
  | { ok: false; errors: string[] } {
  if (!rawCall || typeof rawCall !== "object") {
    return { ok: false, errors: [`tool_calls[${index}]: must be an object`] };
  }
  const record = rawCall as Record<string, unknown>;
  const fn = record.function && typeof record.function === "object" ? (record.function as Record<string, unknown>) : null;
  const name = stringValue(record.name) ?? stringValue(fn?.name);
  const argsRaw =
    record.arguments ??
    record.args ??
    (typeof record.input === "string" ? { input: record.input } : record.input) ??
    fn?.arguments ??
    fn?.args ??
    {};

  if (!name) {
    return { ok: false, errors: [`tool_calls[${index}].name: missing function name`] };
  }

  const args = parseArguments(argsRaw);
  if (!args.ok) {
    return { ok: false, errors: [`tool_calls[${index}].arguments: ${args.error}`] };
  }

  return {
    ok: true,
    id: stringValue(record.id) ?? `call_${randomUUID()}`,
    name,
    arguments: args.value
  };
}

function parseArguments(value: unknown): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return { ok: true, value: value as Record<string, unknown> };
  }
  if (typeof value === "string") {
    try {
      const parsed = value.trim() ? JSON.parse(value) : {};
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return { ok: true, value: parsed as Record<string, unknown> };
      }
      return { ok: false, error: "must decode to a JSON object" };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }
  return { ok: false, error: "must be a JSON object or JSON object string" };
}

async function executeToolCalls(toolCalls: OpenAIToolCall[], parallel: boolean): Promise<string[]> {
  if (parallel) {
    return Promise.all(toolCalls.map((call) => executeLoggedToolCall(call)));
  }

  const results: string[] = [];
  for (const call of toolCalls) {
    results.push(await executeLoggedToolCall(call));
  }
  return results;
}

async function executeLoggedToolCall(call: OpenAIToolCall): Promise<string> {
  const started = performance.now();
  const result = await executeProxyToolCall(call);
  logger.info("TOOLS", "Proxy tool executed", {
    id: call.id,
    name: call.function.name,
    ms: Math.round(performance.now() - started)
  });
  return result;
}

function appendToolResults(
  messages: OpenAIMessage[],
  calls: OpenAIToolCall[],
  results: string[]
): OpenAIMessage[] {
  const next: OpenAIMessage[] = [
    ...messages,
    {
      role: "assistant",
      content: null,
      tool_calls: calls
    }
  ];
  calls.forEach((call, index) => {
    next.push({
      role: "tool",
      tool_call_id: call.id,
      name: call.function.name,
      content: results[index] ?? JSON.stringify({ ok: false, error: "missing tool result" })
    });
  });
  return next;
}

function logToolFormatError(mode: "client" | "proxy", content: string, errors: string[]): void {
  logger.error("TOOLS", "Invalid tool-call format", {
    mode,
    errors,
    raw_preview: content.slice(0, 4000)
  });
}

function toolParseSource(completion: { content: string; reasoningContent: string }): string {
  return [completion.content, completion.reasoningContent].filter(Boolean).join("\n");
}

function synthesizeToolCalls(
  request: ChatCompletionRequest,
  tools: ToolSpec[],
  modelText: string
): OpenAIToolCall[] {
  const prompt = latestUserText(request.messages);
  const requestedTool = namedToolChoice(request.tool_choice);
  const tool =
    (requestedTool ? tools.find((item) => item.name === requestedTool) : null) ??
    selectFilesystemTool(tools, prompt, modelText);
  if (!tool) {
    return [];
  }

  const args = synthesizeArguments(tool, prompt, modelText);
  if (!args) {
    return [];
  }

  const validation = validateToolArguments(tool, args);
  if (!validation.ok) {
    logger.error("TOOLS", "Synthesized tool call failed schema validation", {
      tool: tool.name,
      errors: validation.errors,
      args
    });
    return [];
  }

  return [
    {
      id: `call_${randomUUID()}`,
      type: "function",
      function: {
        name: tool.name,
        arguments: JSON.stringify(validation.value)
      }
    }
  ];
}

function selectFilesystemTool(tools: ToolSpec[], prompt: string, modelText: string): ToolSpec | null {
  const combined = `${prompt}\n${modelText}`;
  if (/(analisa|analisar|olha|inspeciona|inspect|analyze|projeto|project|codebase|workspace|arquivos|files|estrutura|architecture|arquitetura)/i.test(combined)) {
    return findTool(tools, ["list_directory", "list_dir", "directory_tree", "ls", "glob", "read_file", "grep", "search"]);
  }
  if (/(crie|create|write|salve|save|arquivo|file|html|c[oó]digo|code)/i.test(combined)) {
    return findTool(tools, ["write_file", "create_file"]);
  }
  if (/(diret[oó]rio|directory|folder|pasta|mkdir)/i.test(combined)) {
    return findTool(tools, ["create_directory", "mkdir"]);
  }
  return null;
}

function synthesizeArguments(
  tool: ToolSpec,
  prompt: string,
  modelText: string
): Record<string, unknown> | null {
  if (["write_file", "create_file"].includes(tool.name)) {
    const pathKey = firstProperty(tool, ["path", "file_path", "filepath", "relative_path"]);
    const contentKey = firstProperty(tool, ["content", "contents", "text", "body"]);
    if (!pathKey || !contentKey) return null;
    const path = extractFilePath(prompt) ?? extractFilePath(modelText);
    const content = extractFileContent(prompt, modelText);
    if (!path || content === null) return null;
    return { [pathKey]: path, [contentKey]: content };
  }

  if (["create_directory", "mkdir"].includes(tool.name)) {
    const pathKey = firstProperty(tool, ["path", "directory", "dir", "relative_path"]);
    if (!pathKey) return null;
    const path = extractDirectoryPath(prompt) ?? extractDirectoryPath(modelText);
    return path ? { [pathKey]: path } : null;
  }

  if (["list_directory", "list_dir", "directory_tree", "ls"].includes(tool.name)) {
    const pathKey = firstProperty(tool, ["path", "directory", "dir", "relative_path"]) ?? "path";
    return { [pathKey]: "." };
  }

  if (tool.name === "glob") {
    const patternKey = firstProperty(tool, ["pattern", "glob", "query"]) ?? "pattern";
    return { [patternKey]: "**/*" };
  }

  if (["grep", "search"].includes(tool.name)) {
    const queryKey = firstProperty(tool, ["query", "pattern", "search", "regex"]) ?? "query";
    return { [queryKey]: latestSearchQuery(prompt) };
  }

  return null;
}

function findTool(tools: ToolSpec[], names: string[]): ToolSpec | null {
  return tools.find((tool) => names.includes(tool.name)) ?? null;
}

function firstProperty(tool: ToolSpec, candidates: string[]): string | null {
  const properties = tool.parameters.properties ?? {};
  return candidates.find((candidate) => candidate in properties) ?? null;
}

function extractFileContent(prompt: string, modelText: string): string | null {
  const promptContent = prompt.match(/(?:conte[uú]do|content|texto)\s+(?:é|eh|as|:)?\s*[`"']?([^`"'\n.]+)[`"']?/i);
  if (promptContent?.[1]) {
    return promptContent[1]
      .trim()
      .replace(/\s+(usando|using|use|com a|with the)\b[\s\S]*$/i, "")
      .trim();
  }

  const fenced = modelText.match(/```[a-zA-Z0-9_-]*\s*\n([\s\S]*?)```/);
  if (fenced?.[1] !== undefined) {
    return fenced[1].replace(/\n$/, "");
  }

  const textBlock = modelText.match(/```text\s*\n([\s\S]*?)```/i);
  if (textBlock?.[1] !== undefined) {
    return textBlock[1].replace(/\n$/, "");
  }

  return modelText.trim() ? modelText.trim() : null;
}

function extractFilePath(text: string): string | null {
  const labeled = text.match(
    /(?:arquivo|file|path|chamado|called|named|salvar como|save as)\s+[`"']?([A-Za-z0-9_./-]+\.[A-Za-z0-9]{1,12})[`"']?/i
  );
  if (labeled?.[1]) return labeled[1];

  const generic = text.match(
    /\b([A-Za-z0-9_./-]+\.(?:html|css|js|mjs|cjs|ts|tsx|jsx|json|md|txt|py|rs|go|java|c|cpp|h|hpp|yml|yaml|toml|sh|xml|svg))\b/i
  );
  return generic?.[1] ?? null;
}

function extractDirectoryPath(text: string): string | null {
  const labeled = text.match(
    /(?:diret[oó]rio|directory|folder|pasta|mkdir)\s+[`"']?([A-Za-z0-9_./-]+)[`"']?/i
  );
  return labeled?.[1] ?? null;
}

function latestSearchQuery(text: string): string {
  const compact = text.trim().replace(/\s+/g, " ");
  return compact ? compact.slice(0, 120) : ".";
}

function latestUserText(messages: OpenAIMessage[]): string {
  const latest = [...messages].reverse().find((message) => message.role === "user");
  return latest ? flattenMessageContent(latest) : "";
}

function namedToolChoice(toolChoice: unknown): string | null {
  if (!toolChoice || typeof toolChoice !== "object") return null;
  const record = toolChoice as Record<string, unknown>;
  const fn = record.function && typeof record.function === "object" ? (record.function as Record<string, unknown>) : null;
  const custom = record.custom && typeof record.custom === "object" ? (record.custom as Record<string, unknown>) : null;
  return stringValue(fn?.name) ?? stringValue(custom?.name);
}

function toolChoiceAllowsTools(toolChoice: unknown): boolean {
  return toolChoice !== "none";
}

function mustCallTool(toolChoice: unknown): boolean {
  if (toolChoice === "required") return true;
  return Boolean(toolChoice && typeof toolChoice === "object");
}

function toolChoiceText(toolChoice: unknown): string {
  if (toolChoice === "required") return "Tool choice is required: you must call at least one tool.";
  if (toolChoice && typeof toolChoice === "object") {
    return `Tool choice is constrained by the client: ${JSON.stringify(toolChoice)}`;
  }
  return "Tool choice is auto: call tools only when they are useful.";
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function shouldIncludeReasoning(request: ChatCompletionRequest): boolean {
  return Boolean(request.zai?.include_reasoning || request.stream_options?.include_reasoning);
}

function chunkString(value: string, size: number): string[] {
  if (!value) return [""];
  const chunks: string[] = [];
  for (let index = 0; index < value.length; index += size) {
    chunks.push(value.slice(index, index + size));
  }
  return chunks;
}
