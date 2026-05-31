import { randomUUID } from "node:crypto";
import { config } from "../config/env.js";
import type { AccountRepository } from "../db/accounts.js";
import { OPENAI_MODELS } from "../constants/models.js";
import { logger, timing } from "../lib/logger.js";
import { parseSse } from "../lib/sse.js";
import { computeZaiSignature, sortedSignaturePayload } from "../lib/zai-signature.js";
import type { ChatCompletionRequest, OpenAIMessage } from "../types/openai.js";
import type { ZaiAccount } from "../types/zai.js";
import { AccountPool, noUsableAccountMessage } from "./account-pool.js";
import { CaptchaSolver } from "./captcha-solver.js";
import { formatZaiError, getZaiError, latestUserPrompt, normalizeMessages, parseZaiEvent } from "./openai-transform.js";

type CookieLike = {
  name?: string;
  value?: string;
};

type CreatedChat = {
  chatId: string;
  userMessageId: string;
  assistantMessageId: string;
  parentMessageId: string | null;
  conversationKey: string;
};

type CachedConversation = {
  accountId: string;
  model: string;
  chatId: string;
  currentMessageId: string | null;
  updatedAt: number;
};

const CONVERSATION_TTL_MS = 6 * 60 * 60 * 1000;

export class ZaiClient {
  private readonly pool: AccountPool;
  private readonly captcha = new CaptchaSolver();
  private readonly conversations = new Map<string, CachedConversation>();
  private readonly conversationLocks = new Map<string, Promise<void>>();

  constructor(private readonly accounts: AccountRepository) {
    this.pool = new AccountPool(accounts);
  }

  async getActiveAccount(): Promise<ZaiAccount> {
    return this.pool.next();
  }

  async health(): Promise<{ ok: boolean; account: string | null; upstream: string }> {
    const account = this.pool.candidates()[0] ?? null;
    if (!account) {
      return { ok: false, account: null, upstream: "missing_session" };
    }

    try {
      await this.fetchUpstream(account, "/api/models", { method: "GET" });
      this.pool.reportSuccess(account);
      return { ok: true, account: account.email, upstream: "ok" };
    } catch (error) {
      this.pool.reportFailure(account, error);
      logger.warn("HEALTH", "Active account validation failed", error);
      return { ok: false, account: account.email, upstream: "unreachable" };
    }
  }

  async listModels() {
    const account = this.pool.candidates()[0] ?? null;
    if (!account) {
      return OPENAI_MODELS;
    }

    try {
      const upstream = await this.fetchJson<{ data?: Array<Record<string, unknown>> }>(
        account,
        "/api/models",
        { method: "GET" }
      );
      const upstreamModels = (upstream.data ?? [])
        .map((model) => {
          const id = typeof model.id === "string" ? model.id : undefined;
          if (!id) {
            return null;
          }
          return {
            id,
            object: "model" as const,
            created: 1764547200,
            owned_by: "z.ai",
            root: id,
            parent: null,
            capabilities: {
              chat: true,
              streaming: true,
              reasoning: id.includes("GLM-5") || id.includes("GLM-4"),
              tools: true,
              vision: Boolean(getNested(model, ["info", "meta", "capabilities", "vision"])),
              web_search: true,
              image_generation: false,
              agentic_tasks: id.includes("GLM-5"),
              openai_chat_completions: true,
              chat_completions: true,
              prompt_cache_key: true,
              parallel_tool_calls: true,
              interleaved_reasoning: false
            },
            description:
              typeof model.description === "string"
                ? model.description
                : typeof model.name === "string"
                  ? model.name
                  : id,
            family: id.startsWith("GLM-5") ? "GLM-5" : "GLM-4"
          };
        })
        .filter((model) => model !== null);

      if (upstreamModels.length > 0) {
        return mergeModels(upstreamModels);
      }
    } catch (error) {
      logger.warn("UPSTREAM", "Could not load upstream model list; using local catalog", error);
    }

    return OPENAI_MODELS;
  }

  async createCompletionStream(
    request: ChatCompletionRequest,
    signal: AbortSignal
  ): Promise<Response> {
    const accounts = this.pool.candidates();
    if (accounts.length === 0) {
      throw new Error(noUsableAccountMessage(this.accounts.list()));
    }

    let lastError: unknown = null;
    for (const account of accounts) {
      try {
        const response = await this.createCompletionStreamForAccount(account, request, signal);
        this.pool.reportSuccess(account);
        return response;
      } catch (error) {
        lastError = error;
        this.pool.reportFailure(account, error);
      }
    }

    throw lastError instanceof Error ? lastError : new Error(String(lastError ?? "All accounts failed"));
  }

  private async createCompletionStreamForAccount(
    account: ZaiAccount,
    request: ChatCompletionRequest,
    signal: AbortSignal
  ): Promise<Response> {
    const model = normalizeModelId(request.model || config.zai.defaultModel);
    const prompt = latestUserPrompt(request.messages);
    if (!prompt) {
      throw new Error("messages must include at least one user message with text content");
    }
    const created = await this.prepareConversation(account, request, model, prompt, signal);
    const telemetry = this.buildTelemetry(account, created.chatId);
    const sortedPayload = sortedSignaturePayload(telemetry.base);
    const signature = computeZaiSignature(sortedPayload, prompt, telemetry.timestamp);
    const url = `/api/v2/chat/completions?${telemetry.query}&signature_timestamp=${telemetry.timestamp}`;
    const body = this.buildCompletionPayload(request, model, prompt, created);
    const stopTimer = timing("UPSTREAM", "Z.ai completion request");

    try {
      const response = await this.fetchCompletion(account, url, signature, body, signal);
      const inspected = await this.inspectInitialCompletion(response);
      if (inspected.captchaRequired) {
        if (request.zai?.captcha_verify_param) {
          throw new Error("FRONTEND_CAPTCHA_REQUIRED: Z.ai rejected the captcha verification");
        }
        logger.warn("UPSTREAM", "Z.ai requested frontend captcha; solving and retrying");
        const captcha = await this.captcha.solve(account);
        return await this.createCompletionStreamForAccount(
          account,
          {
            ...request,
            zai: {
              ...request.zai,
              captcha_verify_param: captcha,
              force_new_chat: true
            }
          },
          signal
        );
      }

      this.commitConversation(account, model, created);
      return inspected.response;
    } catch (error) {
      if (shouldRetryWithFreshChat(error, request)) {
        this.forgetConversation(created.conversationKey);
        logger.warn("UPSTREAM", "Z.ai internal error on cached chat; retrying once with a fresh chat");
        return await this.createCompletionStreamForAccount(
          account,
          {
            ...request,
            zai: {
              ...request.zai,
              force_new_chat: true,
              fresh_chat_retry: true
            }
          },
          signal
        );
      }
      throw error;
    } finally {
      stopTimer();
    }
  }

  private async fetchCompletion(
    account: ZaiAccount,
    url: string,
    signature: string,
    body: Record<string, unknown>,
    signal: AbortSignal
  ): Promise<Response> {
    const response = await this.fetchUpstream(account, url, {
      method: "POST",
      signal,
      headers: {
        Accept: "text/event-stream",
        "X-Signature": signature
      },
      body: JSON.stringify(body)
    });

    if (!response.body) {
      throw new Error("Z.ai response body is empty");
    }

    return response;
  }

  private async inspectInitialCompletion(
    response: Response
  ): Promise<{ response: Response; captchaRequired: boolean }> {
    if (!response.body) {
      throw new Error("Z.ai response body is empty");
    }

    const [inspectStream, forwardStream] = response.body.tee();
    const forwarded = new Response(forwardStream, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers
    });

    try {
      for await (const event of parseSse(inspectStream)) {
        const parsed = parseZaiEvent(event.data);
        const error = getZaiError(parsed);
        if (error) {
          const code = error.code ?? error.error_code;
          if (code === "FRONTEND_CAPTCHA_REQUIRED") {
            return { response: forwarded, captchaRequired: true };
          }
          throw new Error(formatZaiError(error));
        }
        break;
      }
    } finally {
      void inspectStream.cancel().catch(() => {});
    }

    return { response: forwarded, captchaRequired: false };
  }

  private async prepareConversation(
    account: ZaiAccount,
    request: ChatCompletionRequest,
    model: string,
    prompt: string,
    signal: AbortSignal
  ): Promise<CreatedChat> {
    const conversationKey = this.conversationKey(account, request, model);
    return this.withConversationLock(conversationKey, async () => {
      this.pruneConversations();
      const forceNewChat = Boolean(request.zai?.force_new_chat || request.zai?.captcha_verify_param);
      const cached = this.conversations.get(conversationKey);
      if (!forceNewChat && cached?.accountId === account.id && cached.model === model) {
        return {
          chatId: cached.chatId,
          userMessageId: randomUUID(),
          assistantMessageId: randomUUID(),
          parentMessageId: cached.currentMessageId,
          conversationKey
        };
      }

      return this.createChat(account, request, model, prompt, conversationKey, signal);
    });
  }

  private commitConversation(account: ZaiAccount, model: string, created: CreatedChat): void {
    this.conversations.set(created.conversationKey, {
      accountId: account.id,
      model,
      chatId: created.chatId,
      currentMessageId: created.assistantMessageId,
      updatedAt: Date.now()
    });
  }

  private forgetConversation(conversationKey: string): void {
    this.conversations.delete(conversationKey);
  }

  private conversationKey(account: ZaiAccount, request: ChatCompletionRequest, model: string): string {
    const metadataKey = metadataString(request.metadata, [
      "conversation_id",
      "thread_id",
      "session_id",
      "chat_id"
    ]);
    const raw =
      request.zai?.conversation_key ??
      request.prompt_cache_key ??
      metadataKey ??
      request.previous_response_id ??
      request.user ??
      "default";

    return `${account.id}:${model}:${sanitizeConversationKey(raw)}`;
  }

  private async withConversationLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.conversationLocks.get(key) ?? Promise.resolve();
    let release: () => void = () => {};
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => current);
    this.conversationLocks.set(key, tail);

    await previous.catch(() => undefined);
    try {
      return await fn();
    } finally {
      release();
      if (this.conversationLocks.get(key) === tail) {
        this.conversationLocks.delete(key);
      }
    }
  }

  private pruneConversations(): void {
    const now = Date.now();
    for (const [key, conversation] of this.conversations) {
      if (now - conversation.updatedAt > CONVERSATION_TTL_MS) {
        this.conversations.delete(key);
      }
    }
  }

  private async createChat(
    account: ZaiAccount,
    request: ChatCompletionRequest,
    model: string,
    prompt: string,
    conversationKey: string,
    signal: AbortSignal
  ): Promise<CreatedChat> {
    const userMessageId = randomUUID();
    const assistantMessageId = randomUUID();
    const timestampSeconds = Math.floor(Date.now() / 1000);
    const enableThinking = request.zai?.enable_thinking ?? true;
    const autoWebSearch = request.zai?.auto_web_search ?? false;

    const payload = {
      chat: {
        id: "",
        title: "New Chat",
        models: [model],
        params: {},
        history: {
          messages: {
            [userMessageId]: {
              id: userMessageId,
              parentId: null,
              childrenIds: [],
              role: "user",
              content: prompt,
              timestamp: timestampSeconds,
              models: [model]
            }
          },
          currentId: userMessageId
        },
        tags: [],
        flags: [],
        features: [],
        mcp_servers: [],
        enable_thinking: enableThinking,
        auto_web_search: autoWebSearch,
        message_version: 1,
        extra: {},
        timestamp: Date.now(),
        type: "default"
      }
    };

    const response = await this.fetchJson<{ id?: string; chat?: { id?: string } }>(
      account,
      "/api/v1/chats/new",
      {
        method: "POST",
        signal,
        body: JSON.stringify(payload)
      }
    );

    const chatId = response.chat?.id ?? response.id;
    if (!chatId) {
      throw new Error("Z.ai did not return a chat id");
    }

    return { chatId, userMessageId, assistantMessageId, parentMessageId: null, conversationKey };
  }

  private buildCompletionPayload(
    request: ChatCompletionRequest,
    model: string,
    prompt: string,
    created: CreatedChat
  ) {
    const enableThinking = request.zai?.enable_thinking ?? true;
    const autoWebSearch = request.zai?.auto_web_search ?? false;
    const params: Record<string, unknown> = {};
    if (typeof request.temperature === "number") params.temperature = request.temperature;
    if (typeof request.top_p === "number") params.top_p = request.top_p;
    if (typeof request.max_tokens === "number") params.max_tokens = request.max_tokens;
    if (typeof request.max_completion_tokens === "number") {
      params.max_tokens = request.max_completion_tokens;
    }
    if (request.stop) params.stop = Array.isArray(request.stop) ? request.stop : [request.stop];

    return {
      stream: true,
      model,
      messages: normalizeMessages(request.messages),
      signature_prompt: prompt,
      params,
      extra: {},
      mcp_servers: [],
      features: {
        image_generation: false,
        web_search: false,
        auto_web_search: autoWebSearch,
        preview_mode: true,
        flags: [],
        enable_thinking: enableThinking
      },
      variables: this.variables(),
      chat_id: created.chatId,
      id: created.assistantMessageId,
      current_user_message_id: created.userMessageId,
      current_user_message_parent_id: created.parentMessageId,
      background_tasks: {
        title_generation: true,
        tags_generation: true
      },
      ...(request.zai?.captcha_verify_param
        ? { captcha_verify_param: request.zai.captcha_verify_param }
        : {})
    };
  }

  private buildTelemetry(account: ZaiAccount, chatId: string) {
    const timestamp = String(Date.now());
    const base = {
      timestamp,
      requestId: randomUUID(),
      user_id: account.id
    };

    const query = new URLSearchParams({
      ...base,
      version: "0.0.1",
      platform: "web",
      token: account.token,
      user_agent: account.userAgent,
      language: config.zai.language,
      languages: `${config.zai.language},pt,en-US,en`,
      timezone: config.zai.timezone,
      cookie_enabled: "true",
      screen_width: "1920",
      screen_height: "1080",
      screen_resolution: "1920x1080",
      viewport_height: "960",
      viewport_width: "1343",
      viewport_size: "1343x960",
      color_depth: "24",
      pixel_ratio: "1",
      current_url: `${config.zai.baseUrl}/c/${chatId}`,
      pathname: `/c/${chatId}`,
      search: "",
      hash: "",
      host: new URL(config.zai.baseUrl).host,
      hostname: new URL(config.zai.baseUrl).hostname,
      protocol: new URL(config.zai.baseUrl).protocol,
      referrer: "",
      title: "Z.ai - Free AI Chatbot & Agent powered by GLM-5.1 & GLM-5",
      timezone_offset: "180",
      local_time: new Date().toISOString(),
      utc_time: new Date().toUTCString(),
      is_mobile: "false",
      is_touch: "false",
      max_touch_points: "0",
      browser_name: "Chrome",
      os_name: "Linux"
    }).toString();

    return { timestamp, base, query };
  }

  private variables() {
    const now = new Date();
    return {
      "{{USER_NAME}}": "User",
      "{{USER_LOCATION}}": "Unknown",
      "{{CURRENT_DATETIME}}": now.toISOString(),
      "{{CURRENT_DATE}}": now.toISOString().slice(0, 10),
      "{{CURRENT_TIME}}": now.toLocaleTimeString("en-US"),
      "{{CURRENT_WEEKDAY}}": now.toLocaleDateString("en-US", { weekday: "long" }),
      "{{CURRENT_TIMEZONE}}": config.zai.timezone,
      "{{USER_LANGUAGE}}": config.zai.language
    };
  }

  private async fetchJson<T>(
    account: ZaiAccount,
    path: string,
    init: RequestInit = {}
  ): Promise<T> {
    const response = await this.fetchUpstream(account, path, init);
    return (await response.json()) as T;
  }

  private async fetchUpstream(
    account: ZaiAccount,
    path: string,
    init: RequestInit = {}
  ): Promise<Response> {
    const url = path.startsWith("http") ? path : `${config.zai.baseUrl}${path}`;
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${account.token}`);
    headers.set("Content-Type", headers.get("Content-Type") ?? "application/json");
    headers.set("Accept-Language", config.zai.acceptLanguage);
    headers.set("Origin", config.zai.baseUrl);
    headers.set("Referer", `${config.zai.baseUrl}/`);
    headers.set("User-Agent", account.userAgent);
    headers.set("X-FE-Version", config.zai.feVersion);
    headers.set("X-Region", config.zai.region);
    headers.set("Cookie", cookieHeader(account.cookies));

    const response = await fetch(url, { ...init, headers });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      logger.warn("UPSTREAM", `${response.status} ${response.statusText} from ${path}`, text);
      throw new Error(text || `Z.ai upstream error ${response.status}`);
    }

    return response;
  }
}

function cookieHeader(cookies: unknown[]): string {
  return cookies
    .map((cookie) => cookie as CookieLike)
    .filter((cookie) => cookie.name && cookie.value)
    .map((cookie) => `${cookie.name}=${cookie.value}`)
    .join("; ");
}

function mergeModels(upstreamModels: typeof OPENAI_MODELS): typeof OPENAI_MODELS {
  const byId = new Map<string, (typeof OPENAI_MODELS)[number]>();
  for (const model of OPENAI_MODELS) byId.set(model.id, model);
  for (const model of upstreamModels) byId.set(model.id, model);
  return [...byId.values()];
}

function getNested(value: Record<string, unknown>, path: string[]): unknown {
  let current: unknown = value;
  for (const key of path) {
    if (!current || typeof current !== "object" || !(key in current)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function metadataString(metadata: Record<string, unknown> | null | undefined, keys: string[]): string | null {
  if (!metadata) {
    return null;
  }
  for (const key of keys) {
    const value = metadata[key];
    if (typeof value === "string" && value.trim()) {
      return value;
    }
  }
  return null;
}

function sanitizeConversationKey(value: string): string {
  return value.trim().slice(0, 160).replace(/[^a-zA-Z0-9_.:@/-]+/g, "_") || "default";
}

function normalizeModelId(model: string): string {
  const trimmed = model.trim();
  if (trimmed.includes("/")) {
    return trimmed.split("/").filter(Boolean).at(-1) ?? config.zai.defaultModel;
  }
  return trimmed || config.zai.defaultModel;
}

function shouldRetryWithFreshChat(error: unknown, request: ChatCompletionRequest): boolean {
  if (request.zai?.fresh_chat_retry || request.zai?.force_new_chat || request.zai?.captcha_verify_param) {
    return false;
  }
  const message = error instanceof Error ? error.message : String(error);
  return /INTERNAL_ERROR|Oops, something went wrong/i.test(message);
}
