import { parseSse } from "../lib/sse.js";
import type { OpenAIUsage } from "../types/openai.js";
import { formatZaiError, getZaiError, parseZaiEvent } from "./openai-transform.js";

export type CollectedCompletion = {
  content: string;
  reasoningContent: string;
  usage: OpenAIUsage | null;
};

export async function collectZaiCompletion(
  upstream: ReadableStream<Uint8Array> | null
): Promise<CollectedCompletion> {
  if (!upstream) {
    throw new Error("Z.ai response body is empty");
  }

  let content = "";
  let reasoningContent = "";
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
    if (delta) {
      if (parsed.data.phase === "thinking") {
        reasoningContent += delta;
      } else {
        content += delta;
      }
    }

    if (parsed.data.done || parsed.data.phase === "done") {
      break;
    }
  }

  return { content, reasoningContent, usage };
}

export function addUsage(left: OpenAIUsage | null, right: OpenAIUsage | null): OpenAIUsage | null {
  if (!left) return right;
  if (!right) return left;
  return {
    prompt_tokens: left.prompt_tokens + right.prompt_tokens,
    completion_tokens: left.completion_tokens + right.completion_tokens,
    total_tokens: left.total_tokens + right.total_tokens,
    ...(left.prompt_tokens_details || right.prompt_tokens_details
      ? { prompt_tokens_details: { ...left.prompt_tokens_details, ...right.prompt_tokens_details } }
      : {}),
    ...(left.completion_tokens_details || right.completion_tokens_details
      ? {
          completion_tokens_details: {
            ...left.completion_tokens_details,
            ...right.completion_tokens_details
          }
        }
      : {})
  };
}

export function normalizeUsage(value: unknown): OpenAIUsage | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const usage = value as Record<string, unknown>;
  const promptTokens = numberValue(usage.prompt_tokens);
  const completionTokens = numberValue(usage.completion_tokens);
  const totalTokens = numberValue(usage.total_tokens);
  if (promptTokens === null && completionTokens === null && totalTokens === null) {
    return null;
  }
  return {
    prompt_tokens: promptTokens ?? 0,
    completion_tokens: completionTokens ?? 0,
    total_tokens: totalTokens ?? (promptTokens ?? 0) + (completionTokens ?? 0),
    ...(isRecord(usage.prompt_tokens_details)
      ? { prompt_tokens_details: usage.prompt_tokens_details }
      : {}),
    ...(isRecord(usage.completion_tokens_details)
      ? { completion_tokens_details: usage.completion_tokens_details }
      : {})
  };
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
