import type { Context, Next } from "hono";
import { config } from "../config/env.js";
import { logger } from "../lib/logger.js";
import { openAIError } from "../lib/openai-error.js";

export async function requestLogger(c: Context, next: Next): Promise<void> {
  const start = performance.now();
  await next();
  const ms = Math.round(performance.now() - start);
  logger.info("HTTP", `${c.req.method} ${new URL(c.req.url).pathname} -> ${c.res.status} ${ms}ms`);
}

export async function requireProxyAuth(c: Context, next: Next): Promise<Response | void> {
  if (!config.proxyApiKey) {
    return next();
  }

  const auth = c.req.header("authorization") ?? "";
  const bearer = auth.match(/^Bearer\s+(.+)$/i)?.[1];
  const apiKey = c.req.header("x-api-key");

  if (bearer === config.proxyApiKey || apiKey === config.proxyApiKey) {
    return next();
  }

  const error = openAIError("Invalid proxy API key", 401, "invalid_api_key", "authentication_error");
  return c.json(error.body, error.status);
}
