import { randomUUID } from "node:crypto";
import type { ChatCompletionRequest, OpenAIMessage, OpenAIUsage } from "../types/openai.js";
import type { ZaiCompletionError, ZaiCompletionEvent } from "../types/zai.js";

export function flattenMessageContent(message: OpenAIMessage): string {
  if (typeof message.content === "string") {
    return message.content || formatToolCalls(message);
  }
  if (!message.content) {
    return formatToolCalls(message);
  }
  return message.content
    .map((part) => {
      if (part.type === "text") {
        return part.text;
      }
      if (part.type === "image_url") {
        return `[image_url: ${part.image_url.url}]`;
      }
      return "";
    })
    .filter(Boolean)
    .join("\n") || formatToolCalls(message);
}

export function latestUserPrompt(messages: OpenAIMessage[]): string {
  const latest = [...messages].reverse().find((message) => message.role === "user");
  return latest ? flattenMessageContent(latest).trim() : "";
}

export function normalizeMessages(messages: OpenAIMessage[]): OpenAIMessage[] {
  return messages.flatMap((message) => {
    const role = normalizeZaiRole(message.role);
    const content = normalizeZaiContent(message);
    if (!content && role !== "assistant") {
      return [];
    }
    return { role, content };
  });
}

function normalizeZaiRole(role: OpenAIMessage["role"]): "system" | "user" | "assistant" {
  if (role === "assistant") return "assistant";
  if (role === "system" || role === "developer") return "system";
  return "user";
}

function normalizeZaiContent(message: OpenAIMessage): string {
  const content = flattenMessageContent(message);
  if (message.role !== "tool") {
    return content;
  }
  const label = message.tool_call_id ? `Tool result ${message.tool_call_id}` : "Tool result";
  return `${label}:\n${content}`;
}

function formatToolCalls(message: OpenAIMessage): string {
  if (!Array.isArray(message.tool_calls) || message.tool_calls.length === 0) {
    return "";
  }
  return `Assistant requested tool calls:\n${JSON.stringify(message.tool_calls)}`;
}

export function openAiChunk(
  id: string,
  model: string,
  delta: Record<string, unknown>,
  finishReason: string | null = null,
  usage?: OpenAIUsage | null
) {
  return {
    id,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    system_fingerprint: null,
    choices: [
      {
        index: 0,
        delta,
        finish_reason: finishReason
      }
    ],
    ...(usage ? { usage } : {})
  };
}

export function openAiCompletion(
  request: ChatCompletionRequest,
  content: string,
  reasoningContent: string,
  usage: OpenAIUsage | null,
  options: { includeReasoning?: boolean } = {}
) {
  return {
    id: `chatcmpl-${randomUUID()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: request.model,
    system_fingerprint: null,
    choices: [
      {
        index: 0,
        logprobs: null,
        message: {
          role: "assistant",
          content,
          refusal: null,
          ...(options.includeReasoning && reasoningContent ? { reasoning_content: reasoningContent } : {})
        },
        finish_reason: "stop"
      }
    ],
    usage
  };
}

export function parseZaiEvent(data: string): ZaiCompletionEvent | null {
  if (data === "[DONE]") {
    return null;
  }
  try {
    return JSON.parse(data) as ZaiCompletionEvent;
  } catch {
    return null;
  }
}

export function getZaiError(event: ZaiCompletionEvent | null): ZaiCompletionError | null {
  if (!event) {
    return null;
  }
  return event.error ?? event.data?.error ?? event.data?.data?.error ?? null;
}

export function formatZaiError(error: ZaiCompletionError): string {
  const code = error.code ?? error.error_code;
  const detail = error.detail ?? error.message;
  if (code && detail) {
    return `${code}: ${detail}`;
  }
  return detail ?? code ?? "Z.ai upstream error";
}
