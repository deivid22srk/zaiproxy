import { createContainer } from "../src/bootstrap/container.js";
import { randomUUID } from "node:crypto";
import { computeZaiSignature, sortedSignaturePayload } from "../src/lib/zai-signature.js";

async function main() {
  const container = createContainer();
  const account = container.accounts.list()[0];
  if (!account) {
    console.error("No account found in DB");
    return;
  }

  // 1. Create a new chat first
  const userMessageId = randomUUID();
  const model = "glm-5";
  const prompt = "Hello, who are you?";
  const timestampSeconds = Math.floor(Date.now() / 1000);

  const newChatPayload = {
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
      enable_thinking: true,
      auto_web_search: false,
      message_version: 1,
      extra: {},
      timestamp: Date.now(),
      type: "default"
    }
  };

  const userAgent = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36";
  const headers = new Headers();
  headers.set("Authorization", `Bearer ${account.token}`);
  headers.set("Content-Type", "application/json");
  headers.set("Origin", "https://chat.z.ai");
  headers.set("Referer", "https://chat.z.ai/");
  headers.set("User-Agent", userAgent);
  headers.set("X-FE-Version", "prod-fe-1.1.39");
  headers.set("X-Region", "overseas");
  
  if (account.cookies) {
    const cookieHeader = account.cookies
      .map((c: any) => `${c.name}=${c.value}`)
      .join("; ");
    headers.set("Cookie", cookieHeader);
  }

  console.log("Creating chat...");
  const chatRes = await fetch("https://chat.z.ai/api/v1/chats/new", {
    method: "POST",
    headers,
    body: JSON.stringify(newChatPayload)
  });
  console.log("Chat creation status:", chatRes.status, chatRes.statusText);
  const chatJson = await chatRes.json() as { id?: string; chat?: { id?: string } };
  const chatId = chatJson.chat?.id ?? chatJson.id;
  console.log("Chat ID:", chatId);

  if (!chatId) {
    return;
  }

  // 2. Perform chat completion
  const assistantMessageId = randomUUID();
  const completionBody = {
    stream: true,
    model,
    messages: [
      { role: "user", content: prompt }
    ],
    signature_prompt: prompt,
    params: {},
    extra: {},
    mcp_servers: [],
    features: {
      image_generation: false,
      web_search: false,
      auto_web_search: false,
      preview_mode: true,
      flags: [],
      enable_thinking: true
    },
    variables: {
      "{{USER_NAME}}": "User",
      "{{USER_LOCATION}}": "Unknown",
      "{{CURRENT_DATETIME}}": new Date().toISOString(),
      "{{CURRENT_DATE}}": new Date().toISOString().slice(0, 10),
      "{{CURRENT_TIME}}": new Date().toLocaleTimeString("en-US"),
      "{{CURRENT_WEEKDAY}}": new Date().toLocaleDateString("en-US", { weekday: "long" }),
      "{{CURRENT_TIMEZONE}}": "America/Sao_Paulo",
      "{{USER_LANGUAGE}}": "pt-BR"
    },
    chat_id: chatId,
    id: assistantMessageId,
    current_user_message_id: userMessageId,
    current_user_message_parent_id: null,
    background_tasks: {
      title_generation: true,
      tags_generation: true
    }
  };

  const timestamp = String(Date.now());
  const telemetryBase = {
    timestamp,
    requestId: randomUUID(),
    user_id: account.id
  };
  const sortedPayload = sortedSignaturePayload(telemetryBase);
  const signature = computeZaiSignature(sortedPayload, prompt, timestamp);

  const query = new URLSearchParams({
    ...telemetryBase,
    version: "0.0.1",
    platform: "web",
    token: account.token,
    user_agent: userAgent,
    language: "pt-BR",
    languages: "pt-BR,pt,en-US,en",
    timezone: "America/Sao_Paulo",
    cookie_enabled: "true",
    screen_width: "1920",
    screen_height: "1080",
    screen_resolution: "1920x1080",
    viewport_height: "960",
    viewport_width: "1343",
    viewport_size: "1343x960",
    color_depth: "24",
    pixel_ratio: "1",
    current_url: `https://chat.z.ai/c/${chatId}`,
    pathname: `/c/${chatId}`,
    search: "",
    hash: "",
    host: "chat.z.ai",
    hostname: "chat.z.ai",
    protocol: "https:",
    referrer: "",
    title: "Z.ai - Free AI Chatbot & Agent powered by GLM-5.1 & GLM-5",
    timezone_offset: "180",
    local_time: new Date().toISOString(),
    utc_time: new Date().toUTCString(),
    is_mobile: "false",
    is_touch: "false",
    max_touch_points: "0",
    browser_name: "Chrome",
    os_name: "Linux",
    signature_timestamp: timestamp
  }).toString();

  const completionUrl = `https://chat.z.ai/api/v2/chat/completions?${query}`;
  
  const completionHeaders = new Headers(headers);
  completionHeaders.set("Accept", "text/event-stream");
  completionHeaders.set("X-Signature", signature);

  console.log("Sending completion request...");
  const completionRes = await fetch(completionUrl, {
    method: "POST",
    headers: completionHeaders,
    body: JSON.stringify(completionBody)
  });

  console.log("Completion response status:", completionRes.status, completionRes.statusText);
  const text = await completionRes.text();
  console.log("Completion response body:", text.slice(0, 1000));
}

main().catch(console.error);
