import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import type { Context } from "hono";
import { z } from "zod";
import { config } from "../config/env.js";
import type { ResponseRepository } from "../db/responses.js";
import { upstreamErrorCode, upstreamStatus } from "../lib/http-status.js";
import { openAIError } from "../lib/openai-error.js";
import { parseSse } from "../lib/sse.js";
import { logger } from "../lib/logger.js";
import {
  cancelActiveRequest,
  createActiveRequest,
  isAbortError,
  type ActiveRequestHandle
} from "../services/request-registry.js";
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

const storedResponses = new Map<string, Record<string, unknown>>();
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

export function responsesRoutes(zai: ZaiClient, responseStore?: ResponseRepository): Hono {
  const app = new Hono();

  app.post("/responses", (c) => handleResponseCreate(c, zai, responseStore));
  app.post("/chat/responses", (c) => handleResponseCreate(c, zai, responseStore));
  app.post("/responses/stop", (c) => cancelResponseRequest(c, responseStore));
  app.post("/chat/responses/stop", (c) => cancelResponseRequest(c, responseStore));
  app.post("/responses/:id/cancel", (c) => cancelResponseRequest(c, responseStore));
  app.post("/chat/responses/:id/cancel", (c) => cancelResponseRequest(c, responseStore));

  app.get("/responses/:id", (c) => {
    const id = c.req.param("id");
    const stored = storedResponses.get(id) ?? responseStore?.get(id)?.response;
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
    responseStore?.delete(id);
    cancelActiveRequest(id, "deleted");
    return c.json({ id, object: "response.deleted", deleted: true });
  });

  return app;
}

async function handleResponseCreate(c: Context, zai: ZaiClient, responseStore?: ResponseRepository) {
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
    const conversationKey = responseConversationKey(request, id, responseStore);
    const chatRequest = toChatRequest(request, conversationKey);
    const active = createActiveRequest({
      id,
      kind: "response",
      aliases: [request.previous_response_id, request.prompt_cache_key],
      parentSignal: c.req.raw.signal,
      onCancel: () => zai.cancelRequestConversation(chatRequest)
    });

    try {
      const toolResult = await maybeRunToolBridge(zai, chatRequest, active.signal);
      if (toolResult) {
        if (request.stream) {
          responseConversationKeys.set(id, conversationKey);
          return streamToolBridgeResponse(request, toolResult, id, messageId, createdAt, conversationKey, active, responseStore);
        }
        const response = responseObjectFromToolBridge(request, toolResult, id, messageId, createdAt);
        rememberResponse(id, response, conversationKey, responseStore);
        active.complete();
        return c.json(response);
      }

      const upstream = await zai.createCompletionStream(chatRequest, active.signal);
      if (!upstream.body) {
        throw new Error("Z.ai response body is empty");
      }

      if (request.stream) {
        responseConversationKeys.set(id, conversationKey);
        return streamResponses(request, upstream.body, id, messageId, createdAt, conversationKey, active, responseStore);
      }

      const completion = await collectResponseCompletion(upstream.body);
      const response = responseObject(request, id, messageId, createdAt, "completed", completion.content, completion.usage);
      rememberResponse(id, response, conversationKey, responseStore);
      active.complete();
      return c.json(response);
    } catch (error) {
      active.complete();
      if (isAbortError(error)) {
        const response = responseObject(request, id, messageId, createdAt, "cancelled", "", null);
        rememberResponse(id, response, conversationKey, responseStore);
        return c.json(response);
      }
      const message = error instanceof Error ? error.message : String(error);
      logger.error("HTTP", "Responses request failed", message);
      const status = upstreamStatus(message);
      const response = openAIError(message, status, upstreamErrorCode(status));
      return c.json(response.body, response.status);
    }
}

async function cancelResponseRequest(c: Context, responseStore?: ResponseRepository) {
  const body = await c.req.json().catch(() => ({}));
  const id = c.req.param("id") || requestIdFromBody(body);
  if (!id) {
    const error = openAIError("response_id is required", 400, "missing_required_parameter", "invalid_request_error");
    return c.json(error.body, error.status);
  }

  const result = cancelActiveRequest(id, "client_requested_cancel");
  const responseId = result.ok ? result.id : id;
  const stored = storedResponses.get(responseId) ?? responseStore?.get(responseId)?.response;
  const request: ResponsesRequest = {
    model: typeof stored?.model === "string" ? stored.model : config.zai.defaultModel,
    input: "",
    store: false
  };
  const response = responseObject(request, responseId, `msg_${randomUUID()}`, Math.floor(Date.now() / 1000), "cancelled", "", null);
  storedResponses.set(responseId, response);
  responseStore?.save(responseId, responseConversationKeys.get(responseId) ?? `response:${responseId}`, response);
  return c.json(response, result.ok ? 200 : 404);
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
    messages.push({ role: "developer", content: instructionText });
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
  if (type === "function_call" || type === "custom_tool_call") {
    const call = responseInputToolCall(item);
    if (call) {
      messages.push({
        role: "assistant",
        content: null,
        tool_calls: [call]
      });
    }
    return;
  }

  if (type === "function_call_output" || type === "custom_tool_call_output" || type === "tool_result") {
    const content = flattenResponseText(item.output ?? item.content).trim();
    if (content) {
      const message: OpenAIMessage = { role: "tool", content };
      const callId = stringValue(item.call_id) ?? stringValue(item.tool_call_id) ?? stringValue(item.id);
      if (callId) {
        message.tool_call_id = callId;
      }
      const name = stringValue(item.name);
      if (name) {
        message.name = name;
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
  conversationKey: string,
  active: ActiveRequestHandle,
  responseStore?: ResponseRepository
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
        const data = JSON.stringify({ response_id: id, ...event, sequence_number: sequenceNumber });
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
        rememberResponse(id, completed, conversationKey, responseStore);
        enqueue({
          type: "response.completed",
          response: completed
        });
        controller.close();
      } catch (error) {
        if (isAbortError(error)) {
          const cancelled = responseObject(request, id, messageId, createdAt, "cancelled", content, usage);
          rememberResponse(id, cancelled, conversationKey, responseStore);
          enqueue({ type: "response.completed", response: cancelled });
          controller.close();
          return;
        }
        const message = error instanceof Error ? error.message : String(error);
        logger.error("STREAM", "Responses SSE transform failed", message);
        enqueue({ type: "error", code: "upstream_error", message });
        const failed = responseObject(request, id, messageId, createdAt, "failed", content, usage, {
          code: "upstream_error",
          message
        });
        rememberResponse(id, failed, conversationKey, responseStore);
        enqueue({
          type: "response.failed",
          response: failed
        });
        controller.close();
      } finally {
        active.complete();
      }
    },
    cancel() {
      cancelActiveRequest(id, "client_stream_cancelled");
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
  status: "in_progress" | "completed" | "failed" | "cancelled",
  content: string,
  usage: OpenAIUsage | null,
  error: Record<string, unknown> | null = null,
  outputOverride: Array<Record<string, unknown>> | null = null
) {
  const output =
    outputOverride ??
    (status === "in_progress"
      ? []
      : [outputMessage(messageId, status === "failed" || status === "cancelled" ? "incomplete" : "completed", content)]);
  return {
    id,
    object: "response",
    created_at: createdAt,
    status,
    error,
    incomplete_details:
      status === "failed" ? { reason: "upstream_error" } : status === "cancelled" ? { reason: "cancelled" } : null,
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
  conversationKey: string,
  active: ActiveRequestHandle,
  responseStore?: ResponseRepository
): Response {
  const encoder = new TextEncoder();
  let sequenceNumber = 0;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const enqueue = (event: Record<string, unknown>) => {
        sequenceNumber += 1;
        const type = typeof event.type === "string" ? event.type : "message";
        const data = JSON.stringify({ response_id: id, ...event, sequence_number: sequenceNumber });
        controller.enqueue(encoder.encode(`event: ${type}\ndata: ${data}\n\n`));
      };

      enqueue({
        type: "response.created",
        response: responseObject(request, id, messageId, createdAt, "in_progress", "", null)
      });

      const completed = responseObjectFromToolBridge(request, result, id, messageId, createdAt);
      if (result.kind === "tool_calls") {
        completed.output.forEach((item: Record<string, unknown>, index: number) => {
          const pending = { ...item, status: "in_progress", arguments: "" };
          enqueue({ type: "response.output_item.added", output_index: index, item: pending });
          const args = typeof item.arguments === "string" ? item.arguments : "";
          for (const delta of chunkString(args, 4096)) {
            enqueue({
              type: "response.function_call_arguments.delta",
              item_id: item.id,
              output_index: index,
              content_index: 0,
              delta
            });
          }
          enqueue({
            type: "response.function_call_arguments.done",
            item_id: item.id,
            output_index: index,
            content_index: 0,
            arguments: args
          });
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

      rememberResponse(id, completed, conversationKey, responseStore);
      enqueue({ type: "response.completed", response: completed });
      controller.close();
      active.complete();
    },
    cancel() {
      cancelActiveRequest(id, "client_stream_cancelled");
      active.complete();
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

function responseInputToolCall(item: Record<string, unknown>): OpenAIToolCall | null {
  const name =
    stringValue(item.name) ??
    (isRecord(item.function) ? stringValue(item.function.name) : null) ??
    "tool";
  const args = item.arguments ?? item.input ?? (isRecord(item.function) ? item.function.arguments : undefined) ?? {};
  return {
    id: stringValue(item.call_id) ?? stringValue(item.id) ?? `call_${randomUUID()}`,
    type: "function",
    function: {
      name,
      arguments: typeof args === "string" ? args : JSON.stringify(args)
    }
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function requestIdFromBody(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const record = body as Record<string, unknown>;
  for (const key of ["response_id", "completion_id", "request_id", "id"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function chunkString(value: string, size: number): string[] {
  if (!value) return [""];
  const chunks: string[] = [];
  for (let index = 0; index < value.length; index += size) {
    chunks.push(value.slice(index, index + size));
  }
  return chunks;
}

function responseConversationKey(
  request: ResponsesRequest,
  responseId: string,
  responseStore?: ResponseRepository
): string {
  if (typeof request.prompt_cache_key === "string" && request.prompt_cache_key.trim()) {
    return `prompt:${request.prompt_cache_key.trim()}`;
  }
  if (typeof request.previous_response_id === "string" && request.previous_response_id.trim()) {
    return (
      responseConversationKeys.get(request.previous_response_id) ??
      responseStore?.getConversationKey(request.previous_response_id) ??
      `response:${request.previous_response_id}`
    );
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

function rememberResponse(
  id: string,
  response: Record<string, unknown>,
  conversationKey: string,
  responseStore?: ResponseRepository
): void {
  storedResponses.set(id, response);
  responseConversationKeys.set(id, conversationKey);
  responseStore?.save(id, conversationKey, response);
  responseStore?.prune(MAX_STORED_RESPONSES);
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
