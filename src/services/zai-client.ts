import { randomUUID } from "node:crypto";
import { config } from "../config/env.js";
import type { AccountRepository } from "../db/accounts.js";
import type { ConversationRepository } from "../db/conversations.js";
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

type HealthResult = { ok: boolean; account: string | null; upstream: string; cached?: boolean };
type ModelList = typeof OPENAI_MODELS;

const CONVERSATION_TTL_MS = 6 * 60 * 60 * 1000;

export class ZaiClient {
  private readonly pool: AccountPool;
  private readonly captcha = new CaptchaSolver();
  private readonly conversations = new Map<string, CachedConversation>();
  private readonly conversationLocks = new Map<string, Promise<void>>();
  private healthCache: { value: HealthResult; expiresAt: number } | null = null;
  private healthRefresh: Promise<void> | null = null;
  private modelsCache: { value: ModelList; expiresAt: number } | null = null;
  private modelsRefresh: Promise<void> | null = null;

  constructor(
    private readonly accounts: AccountRepository,
    private readonly conversationStore?: ConversationRepository
  ) {
    this.pool = new AccountPool(accounts);
  }

  async getActiveAccount(): Promise<ZaiAccount> {
    return this.pool.next();
  }

  async health(): Promise<HealthResult> {
    const account = this.pool.candidates()[0] ?? null;
    if (!account) {
      return { ok: false, account: null, upstream: "missing_session" };
    }

    const now = Date.now();
    if (this.healthCache && this.healthCache.expiresAt > now) {
      return { ...this.healthCache.value, cached: true };
    }

    this.refreshHealth(account);
    return this.healthCache?.value ?? { ok: true, account: account.email, upstream: "session_loaded" };
  }

  private refreshHealth(account: ZaiAccount): void {
    if (this.healthRefresh) {
      return;
    }

    this.healthRefresh = new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        void this.loadHealth(account).finally(resolve);
      }, 0);
      timer.unref();
    }).finally(() => {
      this.healthRefresh = null;
    });
  }

  private async loadHealth(account: ZaiAccount): Promise<void> {
    const value = await this.probeHealth(account);
    this.healthCache = { value, expiresAt: Date.now() + config.zai.healthCacheTtlMs };
  }

  private async probeHealth(account: ZaiAccount): Promise<HealthResult> {
    try {
      await this.fetchUpstream(account, "/api/models", {
        method: "GET",
        signal: AbortSignal.timeout(config.zai.fetchTimeoutMs)
      });
      this.pool.reportSuccess(account);
      return { ok: true, account: account.email, upstream: "ok" };
    } catch (error) {
      logger.warn("HEALTH", "Active account validation failed", error);
      return { ok: false, account: account.email, upstream: "unreachable" };
    }
  }

  async listModels(): Promise<ModelList> {
    const now = Date.now();
    if (this.modelsCache && this.modelsCache.expiresAt > now) {
      return this.modelsCache.value;
    }

    this.refreshModels();
    return this.modelsCache?.value ?? OPENAI_MODELS;
  }

  private refreshModels(): void {
    if (this.modelsRefresh) {
      return;
    }

    this.modelsRefresh = new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        void this.loadModels().finally(resolve);
      }, 0);
      timer.unref();
    }).finally(() => {
      this.modelsRefresh = null;
    });
  }

  private async loadModels(): Promise<void> {
    const account = this.pool.candidates()[0] ?? null;
    if (!account) {
      this.modelsCache = { value: OPENAI_MODELS, expiresAt: Date.now() + config.zai.modelsCacheTtlMs };
      return;
    }

    try {
      const upstream = await this.fetchJson<{ data?: Array<Record<string, unknown>> }>(
        account,
        "/api/models",
        { method: "GET", signal: AbortSignal.timeout(config.zai.fetchTimeoutMs) }
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
        this.modelsCache = {
          value: mergeModels(upstreamModels),
          expiresAt: Date.now() + config.zai.modelsCacheTtlMs
        };
        return;
      }
    } catch (error) {
      logger.warn("UPSTREAM", "Could not load upstream model list; using local catalog", error);
    }

    this.modelsCache = { value: OPENAI_MODELS, expiresAt: Date.now() + config.zai.modelsCacheTtlMs };
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

  cancelRequestConversation(request: ChatCompletionRequest): void {
    const model = normalizeModelId(request.model || config.zai.defaultModel);
    const raw = conversationRawKey(request);
    const suffix = `:${model}:${sanitizeConversationKey(raw)}`;
    let removed = 0;
    for (const key of this.conversations.keys()) {
      if (key.endsWith(suffix)) {
        this.conversations.delete(key);
        removed += 1;
      }
    }
    if (removed > 0) {
      logger.info("UPSTREAM", "Dropped cancelled Z.ai conversation cache", { removed, model });
    }
    const persistedRemoved = this.conversationStore?.deleteBySuffix(suffix) ?? 0;
    if (persistedRemoved > 0) {
      logger.info("UPSTREAM", "Dropped persisted cancelled Z.ai conversation cache", {
        removed: persistedRemoved,
        model
      });
    }
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
    const stopTimer = timing("UPSTREAM", "Z.ai completion request");

    try {
      const response = await this.fetchSignedCompletion(account, request, model, prompt, created, signal);
      let inspected = await this.inspectInitialCompletion(response);
      if (inspected.captchaRequired) {
        if (request.zai?.captcha_verify_param) {
          throw new Error("FRONTEND_CAPTCHA_REQUIRED: Z.ai rejected the captcha verification");
        }
        await inspected.response.body?.cancel().catch(() => {});
        logger.warn("UPSTREAM", "Z.ai requested frontend captcha; solving and retrying");
        const captcha = await this.captcha.solve(account);
        const retryRequest = {
          ...request,
          zai: {
            ...request.zai,
            captcha_verify_param: captcha
          }
        };
        const retryResponse = await this.fetchSignedCompletion(account, retryRequest, model, prompt, created, signal);
        inspected = await this.inspectInitialCompletion(retryResponse);
        if (inspected.captchaRequired) {
          throw new Error("FRONTEND_CAPTCHA_REQUIRED: Z.ai rejected the captcha verification");
        }
      }

      return this.persistConversationFromStream(inspected.response, account, model, created);
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

  private async fetchSignedCompletion(
    account: ZaiAccount,
    request: ChatCompletionRequest,
    model: string,
    prompt: string,
    created: CreatedChat,
    signal: AbortSignal
  ): Promise<Response> {
    const telemetry = this.buildTelemetry(account, created.chatId);
    const sortedPayload = sortedSignaturePayload(telemetry.base);
    const signature = computeZaiSignature(sortedPayload, prompt, telemetry.timestamp);
    const url = `/api/v2/chat/completions?${telemetry.query}&signature_timestamp=${telemetry.timestamp}`;
    const body = this.buildCompletionPayload(request, model, prompt, created);
    return this.fetchCompletion(account, url, signature, body, signal);
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

  private persistConversationFromStream(
    response: Response,
    account: ZaiAccount,
    model: string,
    created: CreatedChat
  ): Response {
    if (!response.body) {
      this.commitConversation(account, model, created);
      return response;
    }

    const [observer, forwarded] = response.body.tee();
    void this.observeCompletionParentId(observer, account, model, created);
    return new Response(forwarded, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers
    });
  }

  private async observeCompletionParentId(
    stream: ReadableStream<Uint8Array>,
    account: ZaiAccount,
    model: string,
    created: CreatedChat
  ): Promise<void> {
    let upstreamMessageId: string | null = null;
    try {
      for await (const event of parseSse(stream)) {
        const parsed = parseZaiEvent(event.data);
        const candidate = upstreamParentMessageId(parsed);
        if (candidate) {
          upstreamMessageId = candidate;
        }
        if (parsed?.data?.done || parsed?.data?.phase === "done") {
          break;
        }
      }
    } catch (error) {
      logger.warn("UPSTREAM", "Could not observe Z.ai parent message id; using local fallback", error);
    } finally {
      this.commitConversation(account, model, created, upstreamMessageId ?? created.assistantMessageId);
    }
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
      const forceNewChat = Boolean(request.zai?.force_new_chat);
      const persisted = this.conversationStore?.get(conversationKey) ?? null;
      if (persisted && Date.now() - persisted.updatedAt > CONVERSATION_TTL_MS) {
        this.conversationStore?.delete(conversationKey);
      }
      const cached =
        this.conversations.get(conversationKey) ??
        (persisted && Date.now() - persisted.updatedAt <= CONVERSATION_TTL_MS
          ? {
              accountId: persisted.accountId,
              model: persisted.model,
              chatId: persisted.chatId,
              currentMessageId: persisted.currentMessageId,
              updatedAt: persisted.updatedAt
            }
          : null);
      if (!forceNewChat && cached?.accountId === account.id && cached.model === model) {
        this.conversations.set(conversationKey, { ...cached, updatedAt: Date.now() });
        logger.info("UPSTREAM", "Reusing persisted Z.ai conversation", {
          chat_id: cached.chatId,
          parent_message_id: cached.currentMessageId,
          key: publicConversationKey(conversationKey)
        });
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

  private commitConversation(
    account: ZaiAccount,
    model: string,
    created: CreatedChat,
    currentMessageId = created.assistantMessageId
  ): void {
    const conversation = {
      accountId: account.id,
      model,
      chatId: created.chatId,
      currentMessageId,
      updatedAt: Date.now()
    };
    this.conversations.set(created.conversationKey, conversation);
    this.conversationStore?.save({
      conversationKey: created.conversationKey,
      accountId: conversation.accountId,
      model: conversation.model,
      chatId: conversation.chatId,
      currentMessageId: conversation.currentMessageId
    });
    logger.info("UPSTREAM", "Persisted Z.ai conversation cursor", {
      chat_id: conversation.chatId,
      parent_message_id: conversation.currentMessageId,
      key: publicConversationKey(created.conversationKey)
    });
  }

  private forgetConversation(conversationKey: string): void {
    this.conversations.delete(conversationKey);
    this.conversationStore?.delete(conversationKey);
  }

  private conversationKey(account: ZaiAccount, request: ChatCompletionRequest, model: string): string {
    const raw = conversationRawKey(request);
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
    this.conversationStore?.pruneOlderThan(now - CONVERSATION_TTL_MS);
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

    logger.info("UPSTREAM", "Created new Z.ai conversation", {
      chat_id: chatId,
      key: publicConversationKey(conversationKey)
    });
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

function conversationRawKey(request: ChatCompletionRequest): string {
  const metadataKey = metadataString(request.metadata, [
    "conversation_id",
    "thread_id",
    "session_id",
    "chat_id"
  ]);
  return (
    request.zai?.conversation_key ??
    request.prompt_cache_key ??
    metadataKey ??
    request.previous_response_id ??
    request.user ??
    "default"
  );
}

function sanitizeConversationKey(value: string): string {
  return value.trim().slice(0, 160).replace(/[^a-zA-Z0-9_.:@/-]+/g, "_") || "default";
}

function normalizeModelId(model: string): string {
  const trimmed = model.trim();
  let name = trimmed;
  if (trimmed.includes("/")) {
    name = trimmed.split("/").filter(Boolean).at(-1) ?? config.zai.defaultModel;
  }
  
  const lower = name.toLowerCase();
  if (lower === "glm-5.1") return "GLM-5.1";
  if (lower === "glm-5-turbo") return "GLM-5-Turbo";
  if (lower === "glm-5v-turbo") return "GLM-5v-Turbo";
  if (lower === "glm-5") return "glm-5";
  if (lower === "glm-4.7") return "glm-4.7";
  if (lower === "glm-4.6v") return "glm-4.6v";
  if (lower === "glm-4-flash") return "glm-4-flash";
  if (lower === "glm-4.5-air" || lower === "glm-4-air") return "glm-4-air-250414";
  
  return name;
}

function shouldRetryWithFreshChat(error: unknown, request: ChatCompletionRequest): boolean {
  if (request.zai?.fresh_chat_retry || request.zai?.force_new_chat || request.zai?.captcha_verify_param) {
    return false;
  }
  const message = error instanceof Error ? error.message : String(error);
  return /INTERNAL_ERROR|Oops, something went wrong/i.test(message);
}

function upstreamParentMessageId(event: unknown): string | null {
  const paths = [
    ["data", "response_id"],
    ["data", "message_id"],
    ["data", "id"],
    ["response_id"],
    ["message_id"],
    ["id"],
    ["data", "data", "response_id"],
    ["data", "data", "message_id"],
    ["data", "data", "id"]
  ];
  for (const path of paths) {
    const value = nestedString(event, path);
    if (value && looksLikeMessageId(value)) {
      return value;
    }
  }
  return null;
}

function nestedString(value: unknown, path: string[]): string | null {
  let current = value;
  for (const key of path) {
    if (!current || typeof current !== "object") {
      return null;
    }
    current = (current as Record<string, unknown>)[key];
  }
  return typeof current === "string" && current.trim() ? current.trim() : null;
}

function looksLikeMessageId(value: string): boolean {
  if (!value.trim()) return false;
  if (/^(chatcmpl|resp|req|chat)_/i.test(value)) return false;
  return /^[a-zA-Z0-9_.:-]{8,160}$/.test(value);
}

function publicConversationKey(value: string): string {
  const parts = value.split(":");
  return parts.length > 2 ? parts.slice(1).join(":") : value;
}
