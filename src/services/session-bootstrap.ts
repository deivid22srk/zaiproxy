import { chromium, type BrowserContext, type Page } from "playwright";
import { join } from "node:path";
import type { AccountRepository } from "../db/accounts.js";
import { config } from "../config/env.js";
import { ensureDir } from "../lib/paths.js";
import { decodeJwtPayload } from "../lib/jwt.js";
import { logger } from "../lib/logger.js";
import { isGuestEmail } from "./account-pool.js";
import type { ZaiAccount } from "../types/zai.js";

const LOGIN_TIMEOUT_MS = 15 * 60 * 1000;

export type SessionBootstrapOptions = {
  accountName?: string;
  allowGuest?: boolean;
  freshProfile?: boolean;
  reuseProfile?: boolean;
};

export class SessionBootstrap {
  constructor(private readonly accounts: AccountRepository) {}

  async run(options: SessionBootstrapOptions = {}): Promise<void> {
    const profileName = this.selectProfileName(options);
    const profilePath = ensureDir(join(config.runtimeDir, "profiles", profileName));
    logger.info("AUTH", `Opening Chromium profile at ${profilePath}`);

    const context = await chromium.launchPersistentContext(profilePath, {
      headless: false,
      viewport: { width: 1365, height: 900 },
      args: ["--disable-blink-features=AutomationControlled"]
    });

    try {
      const page = context.pages()[0] ?? (await context.newPage());
      await page.goto(config.zai.baseUrl, { waitUntil: "domcontentloaded" });
      logger.info("AUTH", "Waiting for Z.ai login. Complete the login flow in the browser.");

      const token = await waitForRealToken(page, LOGIN_TIMEOUT_MS, Boolean(options.allowGuest));
      const payload = decodeJwtPayload(token);
      const accountId = payload?.id ?? payload?.sub;
      const email = payload?.email;

      if (!accountId || !email) {
        throw new Error("Could not read account id/email from Z.ai token");
      }
      if (!options.allowGuest && isGuestEmail(email)) {
        throw new Error("Refusing to save guest Z.ai session. Sign in with a real account.");
      }

      const cookies = await context.cookies(config.zai.baseUrl);
      const localStorage = await readLocalStorage(page);
      const userAgent = await page.evaluate(() => navigator.userAgent);

      const account = this.accounts.save({
        id: accountId,
        email,
        displayName: typeof payload?.name === "string" ? payload.name : null,
        token,
        cookies,
        localStorage,
        browserProfilePath: profilePath,
        userAgent
      });

      logger.success("AUTH", `Saved encrypted session for ${account.email} (${account.id})`);
    } finally {
      await context.close();
    }
  }

  private selectProfileName(options: SessionBootstrapOptions): string {
    if (options.accountName) {
      return sanitizeProfileName(options.accountName);
    }

    if (options.freshProfile) {
      return makeFreshProfileName();
    }

    const defaultProfileName = "default";
    const defaultProfilePath = join(config.runtimeDir, "profiles", defaultProfileName);
    const now = new Date().toISOString();
    const profileAccounts = this.accounts
      .list()
      .filter((account) => account.browserProfilePath === defaultProfilePath);

    if (!options.reuseProfile && profileAccounts.length > 0) {
      const hasUsableSession = profileAccounts.some((account) => isUsableRealAccount(account, now));
      if (!hasUsableSession) {
        const first = profileAccounts[0];
        const reason = first
          ? `${first.email} is ${first.status}${first.limitedUntil ? ` until ${first.limitedUntil}` : ""}`
          : "profile has no usable account";
        const freshProfileName = makeFreshProfileName();
        logger.warn(
          "AUTH",
          `Default login profile is tied to an unusable account (${reason}); opening fresh profile ${freshProfileName}`
        );
        logger.warn("AUTH", "Use --reuse-profile to force the old default profile, or --account <name> for a named profile.");
        return freshProfileName;
      }
    }

    return defaultProfileName;
  }
}

async function waitForRealToken(page: Page, timeoutMs: number, allowGuest: boolean): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let lastUrl = page.url();
  let sawGuest = false;

  while (Date.now() < deadline) {
    if (page.url() !== lastUrl) {
      lastUrl = page.url();
      logger.info("AUTH", `Browser navigated to ${lastUrl}`);
    }

    const token = await safeReadToken(page);
    if (token) {
      const payload = decodeJwtPayload(token);
      const email = typeof payload?.email === "string" ? payload.email : "";
      if (allowGuest || (email && !isGuestEmail(email))) {
        return token;
      }

      if (!sawGuest) {
        sawGuest = true;
        logger.warn("AUTH", "Guest session detected; waiting for a real account login.");
        await page.goto(`${config.zai.baseUrl}/auth?redirect=/`, { waitUntil: "domcontentloaded" });
      }
    }
    await page.waitForTimeout(1500);
  }

  throw new Error("Timed out waiting for Z.ai login token");
}

function sanitizeProfileName(value: string): string {
  return value.trim().replace(/[^a-zA-Z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "") || "default";
}

function makeFreshProfileName(): string {
  const stamp = new Date().toISOString().replace(/[^0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return `login-${stamp}`;
}

function isUsableRealAccount(account: ZaiAccount, now: string): boolean {
  return (
    account.status === "active" &&
    !isGuestEmail(account.email) &&
    (!account.limitedUntil || account.limitedUntil <= now)
  );
}

async function safeReadToken(page: Page): Promise<string | null> {
  try {
    return await page.evaluate(() => localStorage.getItem("token"));
  } catch {
    return null;
  }
}

async function readLocalStorage(page: Page): Promise<Record<string, string>> {
  try {
    return await page.evaluate(() => {
      const values: Record<string, string> = {};
      for (let index = 0; index < localStorage.length; index += 1) {
        const key = localStorage.key(index);
        if (key) {
          values[key] = localStorage.getItem(key) ?? "";
        }
      }
      return values;
    });
  } catch {
    return {};
  }
}
