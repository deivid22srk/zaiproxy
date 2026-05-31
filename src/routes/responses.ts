import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { z } from "zod";
import { config } from "../config/env.js";
import { upstreamErrorCode, upstreamStatus } from "../lib/http-status.js";
import { openAIError } from "../lib/openai-error.js";
import { parseSse } from "../lib/sse.js";
import { logger } from "../lib/logger.js";
import type {
  ChatCompletionRequest,
  OpenAIMessage,
  OpenAIRole,
  OpenAIToolCall,
  OpenAIUsage
} from "../types/openai.js";
import type { ZaiClient } from "../services/zai-client.js";
import { formatZaiError, getZaiError, parseZaiEvent } from "../services/openai-transform.js";
import { maybeRunToolBridge, type ToolBridgeResult } from "../services/tool-bridge.js";

type ResponsesRequest = {
  model: string;
  input: unknown;
  instructions?: unknown;
  stream?: boolean;
  temperature?: number;
  top_p?: number;
  max_output_tokens?: number;
  tools?: unknown[];
  tool_choice?: unknown;
  parallel_tool_calls?: boolean;
  prompt_cache_key?: string;
  user?: string;
  previous_response_id?: string;
  metadata?: unknown;
  store?: boolean;
  zai?: ChatCompletionRequest["zai"];
};

const storedResponses = new Map<string, ReturnType<typeof responseObject>>();
const responseConversationKeys = new Map<string, string>();
const MAX_STORED_RESPONSES = 100;

const responsesRequestSchema = z
  .object({
    model: z.string().default(config.zai.defaultModel),
    input: z.unknown(),
    instructions: z.unknown().optional(),
    stream: z.boolean().optional()
  })
  .passthrough()
  .refine((value) => value.input !== undefined, {
    message: "input is required"
  });

export function responsesRoutes(zai: ZaiClient): Hono {
  const app = new Hono();

  app.post("/responses", async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = responsesRequestSchema.safeParse(body);
    if (!parsed.success) {
      const error = openAIError(parsed.error.message, 400, "invalid_request_error", "invalid_request_error");
      return c.json(error.body, error.status);
    }

    const request = parsed.data as ResponsesRequest;
    const id = `resp_${randomUUID()}`;
    const messageId = `msg_${randomUUID()}`;
    const createdAt = Math.floor(Date.now() / 1000);
    const conversationKey = responseConversationKey(request, id);
    const chatRequest = toChatRequest(request, conversationKey);

    try {
      const toolResult = await maybeRunToolBridge(zai, chatRequest, c.req.raw.signal);
      if (toolResult) {
        if (request.stream) {
          responseConversationKeys.set(id, conversationKey);
          return streamToolBridgeResponse(request, toolResult, id, messageId, createdAt, conversationKey);
        }
        const response = responseObjectFromToolBridge(request, toolResult, id, messageId, createdAt);
        rememberResponse(id, response, conversationKey);
        return c.json(response);
      }

      const upstream = await zai.createCompletionStream(chatRequest, c.req.raw.signal);
      if (!upstream.body) {
        throw new Error("Z.ai response body is empty");
      }

      if (request.stream) {
        responseConversationKeys.set(id, conversationKey);
        return streamResponses(request, upstream.body, id, messageId, createdAt, conversationKey);
      }

      const completion = await collectResponseCompletion(upstream.body);
      const response = responseObject(request, id, messageId, createdAt, "completed", completion.content, completion.usage);
      rememberResponse(id, response, conversationKey);
      return c.json(response);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error("HTTP", "Responses request failed", message);
      const status = upstreamStatus(message);
      const response = openAIError(message, status, upstreamErrorCode(status));
      return c.json(response.body, response.status);
    }
  });

  app.get("/responses/:id", (c) => {
    const stored = storedResponses.get(c.req.param("id"));
    if (stored) {
      return c.json(stored);
    }
    const response = openAIError(`Response ${c.req.param("id")} not found`, 404, "not_found", "invalid_request_error");
    return c.json(response.body, response.status);
  });

  app.delete("/responses/:id", (c) => {
    const id = c.req.param("id");
    storedResponses.delete(id);
    responseConversationKeys.delete(id);
    return c.json({ id, object: "response.deleted", deleted: true });
  });

  return app;
}

function toChatRequest(request: ResponsesRequest, conversationKey: string): ChatCompletionRequest {
  const chatRequest: ChatCompletionRequest = {
    model: request.model || config.zai.defaultModel,
    messages: responsesInputToMessages(request.input, request.instructions),
    stream: true,
    stream_options: { include_usage: true },
    prompt_cache_key: request.prompt_cache_key ?? conversationKey,
    metadata: isRecord(request.metadata) ? request.metadata : null,
    zai: {
      ...request.zai,
      conversation_key: conversationKey
    }
  };

  if (typeof request.temperature === "number") chatRequest.temperature = request.temperature;
  if (typeof request.top_p === "number") chatRequest.top_p = request.top_p;
  if (typeof request.max_output_tokens === "number") {
    chatRequest.max_completion_tokens = request.max_output_tokens;
  }
  if (Array.isArray(request.tools)) chatRequest.tools = request.tools;
  if (request.tool_choice !== undefined) chatRequest.tool_choice = request.tool_choice;
  if (typeof request.previous_response_id === "string") {
    chatRequest.previous_response_id = request.previous_response_id;
  }
  if (typeof request.store === "boolean") {
    chatRequest.store = request.store;
  }
  if (typeof request.parallel_tool_calls === "boolean") {
    chatRequest.parallel_tool_calls = request.parallel_tool_calls;
  }
  if (typeof request.user === "string") chatRequest.user = request.user;

  return chatRequest;
}

function responsesInputToMessages(input: unknown, instructions: unknown): OpenAIMessage[] {
  const messages: OpenAIMessage[] = [];
  const instructionText = flattenResponseText(instructions).trim();
  if (instructionText) {
    messages.push({ role: "system", content: instructionText });
  }

  appendResponseInput(messages, input);

  if (!messages.some((message) => message.role === "user")) {
    const fallback = messages
      .map((message) => (typeof message.content === "string" ? message.content : ""))
      .filter(Boolean)
      .join("\n")
      .trim();
    messages.push({ role: "user", content: fallback || "Continue." });
  }

  return messages;
}

function appendResponseInput(messages: OpenAIMessage[], input: unknown): void {
  if (typeof input === "string") {
    messages.push({ role: "user", content: input });
    return;
  }

  if (Array.isArray(input)) {
    for (const item of input) {
      appendResponseInputItem(messages, item);
    }
    return;
  }

  const text = flattenResponseText(input).trim();
  if (text) {
    messages.push({ role: "user", content: text });
  }
}

function appendResponseInputItem(messages: OpenAIMessage[], item: unknown): void {
  if (typeof item === "string") {
    messages.push({ role: "user", content: item });
    return;
  }
  if (!isRecord(item)) {
    return;
  }

  const type = typeof item.type === "string" ? item.type : "";
  if (type === "function_call_output") {
    const content = flattenResponseText(item.output ?? item.content).trim();
    if (content) {
      const message: OpenAIMessage = { role: "tool", content };
      if (typeof item.call_id === "string") {
        message.tool_call_id = item.call_id;
      }
      messages.push(message);
    }
    return;
  }

  const role = normalizeResponseRole(item.role);
  const content = flattenResponseText(item.content ?? item.text ?? item).trim();
  if (content) {
    messages.push({ role, content });
  }
}

function normalizeResponseRole(value: unknown): OpenAIRole {
  if (value === "system" || value === "developer" || value === "assistant" || value === "tool") {
    return value;
  }
  return "user";
}

function flattenResponseText(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(flattenResponseText).filter(Boolean).join("\n");
  }
  if (!isRecord(value)) {
    return "";
  }

  if (typeof value.text === "string") {
    return value.text;
  }
  if (typeof value.output === "string") {
    return value.output;
  }
  if (value.content !== undefined) {
    return flattenResponseText(value.content);
  }
  if (value.summary !== undefined) {
    return flattenResponseText(value.summary);
  }
  return "";
}

async function collectResponseCompletion(
  upstream: ReadableStream<Uint8Array>
): Promise<{ content: string; usage: OpenAIUsage | null }> {
  let content = "";
  let usage: OpenAIUsage | null = null;

  for await (const event of parseSse(upstream)) {
    const parsed = parseZaiEvent(event.data);
    const upstreamError = getZaiError(parsed);
    if (upstreamError) {
      throw new Error(formatZaiError(upstreamError));
    }
    if (!parsed?.data) {
      continue;
    }

    const currentUsage = normalizeUsage(parsed.data.usage);
    if (currentUsage) {
      usage = currentUsage;
    }

    const delta = parsed.data.delta_content;
    if (delta && parsed.data.phase !== "thinking") {
      content += delta;
    }

    if (parsed.data.done || parsed.data.phase === "done") {
      break;
    }
  }

  return { content, usage };
}

function streamResponses(
  request: ResponsesRequest,
  upstream: ReadableStream<Uint8Array>,
  id: string,
  messageId: string,
  createdAt: number,
  conversationKey: string
): Response {
  const encoder = new TextEncoder();
  let sequenceNumber = 0;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let content = "";
      let usage: OpenAIUsage | null = null;

      const enqueue = (event: Record<string, unknown>) => {
        sequenceNumber += 1;
        const type = typeof event.type === "string" ? event.type : "message";
        const data = JSON.stringify({ ...event, sequence_number: sequenceNumber });
        controller.enqueue(encoder.encode(`event: ${type}\ndata: ${data}\n\n`));
      };

      enqueue({
        type: "response.created",
        response: responseObject(request, id, messageId, createdAt, "in_progress", "", null)
      });
      enqueue({
        type: "response.output_item.added",
        output_index: 0,
        item: outputMessage(messageId, "in_progress", "")
      });
      enqueue({
        type: "response.content_part.added",
        item_id: messageId,
        output_index: 0,
        content_index: 0,
        part: { type: "output_text", text: "", annotations: [] }
      });

      try {
        for await (const event of parseSse(upstream)) {
          const parsed = parseZaiEvent(event.data);
          const upstreamError = getZaiError(parsed);
          if (upstreamError) {
            throw new Error(formatZaiError(upstreamError));
          }
          if (!parsed?.data) {
            continue;
          }

          const currentUsage = normalizeUsage(parsed.data.usage);
          if (currentUsage) {
            usage = currentUsage;
          }

          const delta = parsed.data.delta_content;
          if (delta && parsed.data.phase !== "thinking") {
            content += delta;
            enqueue({
              type: "response.output_text.delta",
              item_id: messageId,
              output_index: 0,
              content_index: 0,
              delta
            });
          }

          if (parsed.data.done || parsed.data.phase === "done") {
            break;
          }
        }

        enqueue({
          type: "response.output_text.done",
          item_id: messageId,
          output_index: 0,
          content_index: 0,
          text: content
        });
        enqueue({
          type: "response.content_part.done",
          item_id: messageId,
          output_index: 0,
          content_index: 0,
          part: { type: "output_text", text: content, annotations: [] }
        });
        enqueue({
          type: "response.output_item.done",
          output_index: 0,
          item: outputMessage(messageId, "completed", content)
        });
        const completed = responseObject(request, id, messageId, createdAt, "completed", content, usage);
        rememberResponse(id, completed, conversationKey);
        enqueue({
          type: "response.completed",
          response: completed
        });
        controller.close();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error("STREAM", "Responses SSE transform failed", message);
        enqueue({ type: "error", code: "upstream_error", message });
        const failed = responseObject(request, id, messageId, createdAt, "failed", content, usage, {
          code: "upstream_error",
          message
        });
        rememberResponse(id, failed, conversationKey);
        enqueue({
          type: "response.failed",
          response: failed
        });
        controller.close();
      }
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

function responseObject(
  request: ResponsesRequest,
  id: string,
  messageId: string,
  createdAt: number,
  status: "in_progress" | "completed" | "failed",
  content: string,
  usage: OpenAIUsage | null,
  error: Record<string, unknown> | null = null,
  outputOverride: Array<Record<string, unknown>> | null = null
) {
  const output =
    outputOverride ??
    (status === "in_progress"
      ? []
      : [outputMessage(messageId, status === "failed" ? "incomplete" : "completed", content)]);
  return {
    id,
    object: "response",
    created_at: createdAt,
    status,
    error,
    incomplete_details: status === "failed" ? { reason: "upstream_error" } : null,
    instructions: typeof request.instructions === "string" ? request.instructions : null,
    max_output_tokens: request.max_output_tokens ?? null,
    model: request.model || config.zai.defaultModel,
    output,
    parallel_tool_calls: request.parallel_tool_calls ?? false,
    previous_response_id: typeof request.previous_response_id === "string" ? request.previous_response_id : null,
    reasoning: { effort: null, summary: null },
    store: request.store ?? false,
    temperature: request.temperature ?? null,
    text: { format: { type: "text" } },
    tool_choice: request.tool_choice ?? "auto",
    tools: Array.isArray(request.tools) ? request.tools : [],
    top_p: request.top_p ?? null,
    truncation: "disabled",
    usage: responseUsage(usage),
    metadata: isRecord(request.metadata) ? request.metadata : {}
  };
}

function responseObjectFromToolBridge(
  request: ResponsesRequest,
  result: ToolBridgeResult,
  id: string,
  messageId: string,
  createdAt: number
) {
  if (result.kind === "final") {
    return responseObject(request, id, messageId, createdAt, "completed", result.content, result.usage);
  }
  return responseObject(
    request,
    id,
    messageId,
    createdAt,
    "completed",
    "",
    result.usage,
    null,
    result.toolCalls.map((call) => outputFunctionCall(call))
  );
}

function streamToolBridgeResponse(
  request: ResponsesRequest,
  result: ToolBridgeResult,
  id: string,
  messageId: string,
  createdAt: number,
  conversationKey: string
): Response {
  const encoder = new TextEncoder();
  let sequenceNumber = 0;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const enqueue = (event: Record<string, unknown>) => {
        sequenceNumber += 1;
        const type = typeof event.type === "string" ? event.type : "message";
        const data = JSON.stringify({ ...event, sequence_number: sequenceNumber });
        controller.enqueue(encoder.encode(`event: ${type}\ndata: ${data}\n\n`));
      };

      enqueue({
        type: "response.created",
        response: responseObject(request, id, messageId, createdAt, "in_progress", "", null)
      });

      const completed = responseObjectFromToolBridge(request, result, id, messageId, createdAt);
      if (result.kind === "tool_calls") {
        completed.output.forEach((item: Record<string, unknown>, index: number) => {
          enqueue({ type: "response.output_item.added", output_index: index, item });
          enqueue({ type: "response.output_item.done", output_index: index, item });
        });
      } else {
        enqueue({
          type: "response.output_item.added",
          output_index: 0,
          item: outputMessage(messageId, "in_progress", "")
        });
        enqueue({
          type: "response.output_text.delta",
          item_id: messageId,
          output_index: 0,
          content_index: 0,
          delta: result.content
        });
        enqueue({
          type: "response.output_text.done",
          item_id: messageId,
          output_index: 0,
          content_index: 0,
          text: result.content
        });
        enqueue({
          type: "response.output_item.done",
          output_index: 0,
          item: outputMessage(messageId, "completed", result.content)
        });
      }

      rememberResponse(id, completed, conversationKey);
      enqueue({ type: "response.completed", response: completed });
      controller.close();
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

function outputFunctionCall(toolCall: OpenAIToolCall) {
  return {
    id: `fc_${randomUUID()}`,
    type: "function_call",
    status: "completed",
    call_id: toolCall.id,
    name: toolCall.function.name,
    arguments: toolCall.function.arguments
  };
}

function outputMessage(id: string, status: "in_progress" | "completed" | "incomplete", content: string) {
  return {
    id,
    type: "message",
    status,
    role: "assistant",
    content:
      status === "in_progress"
        ? []
        : [
            {
              type: "output_text",
              text: content,
              annotations: []
            }
          ]
  };
}

function responseUsage(usage: OpenAIUsage | null) {
  if (!usage) {
    return null;
  }
  return {
    input_tokens: usage.prompt_tokens,
    input_tokens_details: usage.prompt_tokens_details ?? { cached_tokens: 0 },
    output_tokens: usage.completion_tokens,
    output_tokens_details: usage.completion_tokens_details ?? { reasoning_tokens: 0 },
    total_tokens: usage.total_tokens
  };
}

function normalizeUsage(value: unknown): OpenAIUsage | null {
  if (!isRecord(value)) {
    return null;
  }
  const promptTokens = numberValue(value.prompt_tokens);
  const completionTokens = numberValue(value.completion_tokens);
  const totalTokens = numberValue(value.total_tokens);
  if (promptTokens === null && completionTokens === null && totalTokens === null) {
    return null;
  }
  return {
    prompt_tokens: promptTokens ?? 0,
    completion_tokens: completionTokens ?? 0,
    total_tokens: totalTokens ?? (promptTokens ?? 0) + (completionTokens ?? 0),
    ...(isRecord(value.prompt_tokens_details) ? { prompt_tokens_details: value.prompt_tokens_details } : {}),
    ...(isRecord(value.completion_tokens_details)
      ? { completion_tokens_details: value.completion_tokens_details }
      : {})
  };
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function responseConversationKey(request: ResponsesRequest, responseId: string): string {
  if (typeof request.prompt_cache_key === "string" && request.prompt_cache_key.trim()) {
    return `prompt:${request.prompt_cache_key.trim()}`;
  }
  if (typeof request.previous_response_id === "string" && request.previous_response_id.trim()) {
    return responseConversationKeys.get(request.previous_response_id) ?? `response:${request.previous_response_id}`;
  }
  const metadata = isRecord(request.metadata) ? request.metadata : null;
  const metadataKey = metadataString(metadata, ["conversation_id", "thread_id", "session_id", "chat_id"]);
  if (metadataKey) {
    return `metadata:${metadataKey}`;
  }
  if (typeof request.user === "string" && request.user.trim()) {
    return `user:${request.user.trim()}`;
  }
  return `response:${responseId}`;
}

function rememberResponse(id: string, response: ReturnType<typeof responseObject>, conversationKey: string): void {
  storedResponses.set(id, response);
  responseConversationKeys.set(id, conversationKey);
  while (storedResponses.size > MAX_STORED_RESPONSES) {
    const oldest = storedResponses.keys().next().value;
    if (typeof oldest !== "string") break;
    storedResponses.delete(oldest);
    responseConversationKeys.delete(oldest);
  }
}

function metadataString(metadata: Record<string, unknown> | null, keys: string[]): string | null {
  if (!metadata) {
    return null;
  }
  for (const key of keys) {
    const value = metadata[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return null;
}
