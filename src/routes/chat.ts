import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { z } from "zod";
import type { ZaiClient } from "../services/zai-client.js";
import { config } from "../config/env.js";
import { openAIError } from "../lib/openai-error.js";
import { upstreamErrorCode, upstreamStatus } from "../lib/http-status.js";
import { encodeSse, parseSse } from "../lib/sse.js";
import { logger } from "../lib/logger.js";
import type { ChatCompletionRequest, OpenAIUsage } from "../types/openai.js";
import { collectZaiCompletion, normalizeUsage } from "../services/completion-collector.js";
import {
  formatZaiError,
  getZaiError,
  openAiChunk,
  openAiCompletion,
  parseZaiEvent
} from "../services/openai-transform.js";
import {
  maybeRunToolBridge,
  streamToolBridgeResult,
  toolBridgeCompletion
} from "../services/tool-bridge.js";

const chatRequestSchema = z
  .object({
    model: z.string().default(config.zai.defaultModel),
    messages: z.array(z.record(z.unknown())).min(1),
    stream: z.boolean().optional()
  })
  .passthrough();

export function chatRoutes(zai: ZaiClient): Hono {
  const app = new Hono();

  app.post("/chat/completions", async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = chatRequestSchema.safeParse(body);
    if (!parsed.success) {
      const error = openAIError(parsed.error.message, 400, "invalid_request_error", "invalid_request_error");
      return c.json(error.body, error.status);
    }

    const request = parsed.data as unknown as ChatCompletionRequest;
    const requestId = `msg_${randomUUID()}`;
    logger.info("HTTP", "Chat completion accepted", {
      request_id: requestId,
      model: request.model,
      stream: Boolean(request.stream),
      tools: Array.isArray(request.tools) ? request.tools.length : 0,
      parallel_tool_calls: request.parallel_tool_calls ?? null,
      prompt_cache_key: request.prompt_cache_key ?? request.zai?.conversation_key ?? null
    });
    try {
      const toolResult = await maybeRunToolBridge(zai, request, c.req.raw.signal);
      if (toolResult) {
        if (request.stream) {
          return streamToolBridgeResult(request, toolResult);
        }
        return c.json(toolBridgeCompletion(request, toolResult));
      }

      const upstream = await zai.createCompletionStream(request, c.req.raw.signal);
      if (request.stream) {
        return streamOpenAI(request, upstream.body);
      }

      const completion = await collectCompletion(request, upstream.body);
      return c.json(completion);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error("HTTP", "Chat completion failed", message);
      const status = upstreamStatus(message);
      const response = openAIError(message, status, upstreamErrorCode(status));
      return c.json(response.body, response.status);
    }
  });

  app.get("/chat/completions/:id", (c) => {
    const error = openAIError(
      `Chat completion ${c.req.param("id")} is not stored by this proxy`,
      404,
      "not_found",
      "invalid_request_error"
    );
    return c.json(error.body, error.status);
  });

  app.delete("/chat/completions/:id", (c) =>
    c.json({
      object: "chat.completion.deleted",
      id: c.req.param("id"),
      deleted: true
    })
  );

  return app;
}

function streamOpenAI(request: ChatCompletionRequest, upstream: ReadableStream<Uint8Array> | null): Response {
  if (!upstream) {
    const error = openAIError("Z.ai response body is empty", 502, "upstream_error");
    return Response.json(error.body, { status: error.status });
  }

  const id = `chatcmpl-${randomUUID()}`;
  const model = request.model;
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let usage: OpenAIUsage | null = null;
      controller.enqueue(encodeSse(openAiChunk(id, model, { role: "assistant" })));

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
          if (delta) {
            if (parsed.data.phase === "thinking") {
              if (!shouldIncludeReasoning(request)) {
                continue;
              }
              controller.enqueue(encodeSse(openAiChunk(id, model, { reasoning_content: delta })));
            } else {
              controller.enqueue(encodeSse(openAiChunk(id, model, { content: delta })));
            }
          }

          if (parsed.data.done || parsed.data.phase === "done") {
            break;
          }
        }

        controller.enqueue(
          encodeSse(
            openAiChunk(
              id,
              model,
              {},
              "stop",
              request.stream_options?.include_usage ? usage : null
            )
          )
        );
        controller.enqueue(encodeSse("[DONE]"));
        controller.close();
      } catch (error) {
        logger.error("STREAM", "SSE transform failed", error);
        controller.error(error);
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

async function collectCompletion(
  request: ChatCompletionRequest,
  upstream: ReadableStream<Uint8Array> | null
) {
  if (!upstream) {
    throw new Error("Z.ai response body is empty");
  }

  const { content, reasoningContent, usage } = await collectZaiCompletion(upstream);
  return openAiCompletion(request, content, reasoningContent, usage, {
    includeReasoning: shouldIncludeReasoning(request)
  });
}

function shouldIncludeReasoning(request: ChatCompletionRequest): boolean {
  return Boolean(request.zai?.include_reasoning || request.stream_options?.include_reasoning);
}
