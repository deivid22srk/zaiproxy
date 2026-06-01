import { join } from "node:path";
import type { BrowserContext, Page } from "playwright";
import { config } from "../config/env.js";
import { ensureDir } from "../lib/paths.js";
import { logger } from "../lib/logger.js";
import type { ZaiAccount } from "../types/zai.js";

const CAPTCHA_SCRIPT_URL = "https://o.alicdn.com/captcha-frontend/aliyunCaptcha/AliyunCaptcha.js";

type CaptchaSession = {
  accountId: string;
  context: BrowserContext;
  page: Page;
  preparedAt: number;
};

export class CaptchaSolver {
  private readonly solveQueues = new Map<string, Promise<void>>();
  private session: CaptchaSession | null = null;
  private idleTimer: NodeJS.Timeout | null = null;

  async solve(account: ZaiAccount): Promise<string> {
    const previous = this.solveQueues.get(account.id) ?? Promise.resolve();
    const solve = previous.catch(() => undefined).then(() => this.solveFresh(account));
    const queueTail = solve.then(
      () => undefined,
      () => undefined
    );

    this.solveQueues.set(account.id, queueTail);
    try {
      return await solve;
    } finally {
      if (this.solveQueues.get(account.id) === queueTail) {
        this.solveQueues.delete(account.id);
      }
    }
  }

  private async getSession(account: ZaiAccount): Promise<CaptchaSession> {
    this.clearIdleTimer();
    if (this.session?.accountId === account.id && !this.session.page.isClosed()) {
      return this.session;
    }

    await this.closeSession();
    const { chromium } = await import("playwright");
    const profilePath = ensureDir(join(config.runtimeDir, "captcha-profiles", sanitizeProfileSegment(account.id)));
    logger.warn(
      "AUTH",
      `Z.ai captcha required; starting ${config.captcha.headless ? "headless" : "visible"} Chromium at ${profilePath}`
    );

    const context = await chromium.launchPersistentContext(profilePath, {
      headless: config.captcha.headless,
      viewport: { width: 1365, height: 900 },
      args: [
        "--disable-blink-features=AutomationControlled",
        "--disable-background-timer-throttling",
        "--disable-renderer-backgrounding"
      ]
    });
    await context
      .route("**/*", (route) => {
        const type = route.request().resourceType();
        if (type === "font" || type === "media") {
          return route.abort();
        }
        return route.continue();
      })
      .catch(() => {});

    context.on("close", () => {
      if (this.session?.context === context) {
        this.session = null;
      }
    });

    const page = context.pages()[0] ?? (await context.newPage());
    this.session = { accountId: account.id, context, page, preparedAt: 0 };
    return this.session;
  }

  private async closeSession(): Promise<void> {
    this.clearIdleTimer();
    const session = this.session;
    this.session = null;
    if (session) {
      await session.context.close().catch(() => {});
    }
  }

  private async preparePage(session: CaptchaSession, account: ZaiAccount): Promise<Page> {
    const page = session.page.isClosed() ? await session.context.newPage() : session.page;
    if (page !== session.page) {
      this.session = { ...session, page, preparedAt: 0 };
    }

    if (this.session?.accountId === account.id && Date.now() - this.session.preparedAt < 5 * 60 * 1000) {
      return page;
    }

    await session.context.addCookies(account.cookies as Parameters<typeof session.context.addCookies>[0]).catch(() => {});
    await page.goto(config.zai.baseUrl, { waitUntil: "domcontentloaded" });
    await page.evaluate(
      ({ localStorageValues, token }) => {
        for (const [key, value] of Object.entries(localStorageValues)) {
          window.localStorage.setItem(key, value);
        }
        window.localStorage.setItem("token", token);
      },
      { localStorageValues: account.localStorage, token: account.token }
    );

    await page.goto(config.zai.baseUrl, { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("load", { timeout: 10000 }).catch(() => {});
    if (this.session?.accountId === account.id) {
      this.session.preparedAt = Date.now();
    }
    return page;
  }

  private async solveFresh(account: ZaiAccount): Promise<string> {
    const session = await this.getSession(account);

    try {
      const page = await this.preparePage(session, account);
      const captcha = await page.evaluate(
        ({ language, scriptUrl, timeoutMs }) =>
          new Promise<string>((resolve, reject) => {
            const elementId = "chat-captcha-element";
            const buttonId = "chat-captcha-trigger";
            let instance: { refresh?: () => void } | null = null;
            let settled = false;
            const timer = window.setTimeout(() => fail("captcha timed out"), timeoutMs);

            const finish = (value: unknown) => {
              if (settled) return;
              settled = true;
              window.clearTimeout(timer);
              try {
                instance?.refresh?.();
              } catch {
                // Best effort; the same hidden browser can be reused for the next captcha.
              }
              if (typeof value === "string") {
                resolve(value);
                return;
              }
              if (value && typeof value === "object") {
                const record = value as Record<string, unknown>;
                const nested =
                  record.captcha_verify_param ??
                  record.captchaVerifyParam ??
                  record.verifyParam ??
                  record.token;
                if (typeof nested === "string") {
                  resolve(nested);
                  return;
                }
              }
              resolve(JSON.stringify(value));
            };

            const fail = (message: string) => {
              if (settled) return;
              settled = true;
              window.clearTimeout(timer);
              reject(new Error(message));
            };

            const ensureNode = (id: string, tagName: "div" | "button") => {
              let node = document.getElementById(id);
              if (!node) {
                node = document.createElement(tagName);
                node.id = id;
                node.style.cssText =
                  "position:absolute;left:-99999px;top:-99999px;width:1px;height:1px;opacity:0;overflow:hidden;";
                if (tagName === "button") {
                  (node as HTMLButtonElement).type = "button";
                  node.setAttribute("aria-hidden", "true");
                  (node as HTMLButtonElement).tabIndex = -1;
                }
                document.body.appendChild(node);
              }
              return node;
            };

            const loadScript = () =>
              new Promise<void>((scriptResolve, scriptReject) => {
                if (window.initAliyunCaptcha) {
                  scriptResolve();
                  return;
                }
                window.AliyunCaptchaConfig = { region: "sgp", prefix: "no8xfe" };
                const existing = document.querySelector<HTMLScriptElement>(`script[src="${scriptUrl}"]`);
                if (existing) {
                  existing.addEventListener("load", () => scriptResolve(), { once: true });
                  existing.addEventListener("error", () => scriptReject(new Error("captcha script load failed")), {
                    once: true
                  });
                  return;
                }
                const script = document.createElement("script");
                script.src = scriptUrl;
                script.onload = () => scriptResolve();
                script.onerror = () => scriptReject(new Error("captcha script load failed"));
                document.head.appendChild(script);
              });

            const messages = {
              cn: {
                START_VERIFY: "点击开始验证",
                POPUP_TITLE: "请完成安全验证",
                SLIDE_TIP: "请按住滑块，拖动到最右边",
                CHECK_BOX_TIP: "确认您不是机器人",
                PUZZLE_TIP: "请拖动滑块完成拼图",
                INPAINTING_TIP: "请拖动滑块还原完整图片",
                VERIFYING: "验证中...",
                SUCCESS: "滑动成功!",
                SLIDE_FAIL: "验证失败，请刷新重试",
                CAPTCHA_FAIL: "验证失败，请重试!",
                CONGESTION: "前方拥堵，请刷新重试",
                CAPTCHA_COMPLETED: "滑动完成",
                FINISH_CAPTCHA: "请先完成验证！"
              },
              en: {
                START_VERIFY: "Click to start verification",
                POPUP_TITLE: "Please complete security verification",
                SLIDE_TIP: "Please drag slider right",
                CHECK_BOX_TIP: "Confirm you are not a robot",
                PUZZLE_TIP: "Please drag the slider to complete the puzzle",
                INPAINTING_TIP: "Please drag the slider to restore the complete image",
                VERIFYING: "Verifying...",
                SUCCESS: "Slide successful!",
                SLIDE_FAIL: "Verification failed, please refresh and try again",
                CAPTCHA_FAIL: "Verification failed, please try again!",
                CONGESTION: "Network congestion, please refresh and try again",
                CAPTCHA_COMPLETED: "Slide completed",
                FINISH_CAPTCHA: "Please complete verification first!"
              }
            };

            loadScript()
              .then(() => {
                ensureNode(elementId, "div");
                const button = ensureNode(buttonId, "button") as HTMLButtonElement;
                if (!window.initAliyunCaptcha) {
                  fail("initAliyunCaptcha missing");
                  return;
                }
                window.initAliyunCaptcha({
                  SceneId: window.location.hostname === "chat.z.ai" ? "didk33e0" : "xswyjefn",
                  mode: "popup",
                  element: `#${elementId}`,
                  button: `#${buttonId}`,
                  captchaLogoImg: "https://z-cdn.chatglm.cn/z-ai/static/logo.svg",
                  upLang: messages,
                  language: language === "en-US" ? "en" : "cn",
                  timeout: 10000,
                  delayBeforeSuccess: false,
                  success: finish,
                  fail: () => window.setTimeout(() => button.click(), 250),
                  onError: (error: unknown) => fail(`captcha service error: ${String(error)}`),
                  onClose: () => fail("captcha cancelled by user"),
                  getInstance: (value: { refresh?: () => void }) => {
                    instance = value;
                    window.setTimeout(() => button.click(), 250);
                  }
                });
              })
              .catch((error: unknown) => fail(error instanceof Error ? error.message : String(error)));
          }),
        {
          language: config.zai.acceptLanguage,
          scriptUrl: CAPTCHA_SCRIPT_URL,
          timeoutMs: config.captcha.timeoutMs
        }
      );

      logger.success("AUTH", "Z.ai captcha verification completed");
      return captcha;
    } finally {
      if (!config.captcha.keepBrowserOpen) {
        await this.closeSession();
      } else {
        this.scheduleIdleClose();
      }
    }
  }

  private scheduleIdleClose(): void {
    this.clearIdleTimer();
    this.idleTimer = setTimeout(() => {
      void this.closeSession();
    }, config.captcha.idleTtlMs);
    this.idleTimer.unref();
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }
}

function sanitizeProfileSegment(value: string): string {
  return value.trim().replace(/[^a-zA-Z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "") || "default";
}

declare global {
  interface Window {
    AliyunCaptchaConfig?: { region: string; prefix: string };
    initAliyunCaptcha?: (options: Record<string, unknown>) => void;
  }
}
