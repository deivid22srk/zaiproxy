import { join } from "node:path";
import { readFileSync, existsSync } from "node:fs";
import type { AccountRepository } from "../db/accounts.js";
import { config } from "../config/env.js";
import { ensureDir } from "../lib/paths.js";
import { decodeJwtPayload } from "../lib/jwt.js";
import { logger } from "../lib/logger.js";

export type SessionBootstrapOptions = {
  accountName?: string;
  allowGuest?: boolean;
  freshProfile?: boolean;
  reuseProfile?: boolean;
  cookies?: string;
};

function cleanCookieJson(raw: string): string {
  let insideString = false;
  let result = "";
  for (let i = 0; i < raw.length; i++) {
    const char = raw[i];
    if (char === '"' && raw[i - 1] !== '\\') {
      insideString = !insideString;
      result += char;
    } else if (insideString) {
      if (char === '\n' || char === '\r') {
        continue;
      }
      result += char;
    } else {
      result += char;
    }
  }
  return result;
}

export class SessionBootstrap {
  constructor(private readonly accounts: AccountRepository) {}

  async run(options: SessionBootstrapOptions = {}): Promise<void> {
    const source = options.cookies;
    if (!source) {
      logger.error("AUTH", "Chrome/Playwright login is disabled.");
      logger.info("AUTH", "Please login using cookies by specifying the --cookies parameter:");
      logger.info("AUTH", "  npm run bootstrap -- --cookies <file_or_url>");
      logger.info("AUTH", "Example:");
      logger.info("AUTH", "  npm run bootstrap -- --cookies https://paste.centos.org/view/raw/9ec45bbb");
      throw new Error("Missing --cookies parameter. Chromium login is disabled.");
    }

    let rawContent = "";
    if (source.startsWith("http://") || source.startsWith("https://")) {
      logger.info("AUTH", `Fetching cookies from URL: ${source}`);
      const res = await fetch(source);
      if (!res.ok) {
        throw new Error(`Failed to fetch cookies from URL: ${res.statusText}`);
      }
      rawContent = await res.text();
    } else {
      logger.info("AUTH", `Reading cookies from file: ${source}`);
      if (!existsSync(source)) {
        throw new Error(`File not found: ${source}`);
      }
      rawContent = readFileSync(source, "utf8");
    }

    const cleaned = cleanCookieJson(rawContent);
    let cookiesList: any[];
    try {
      cookiesList = JSON.parse(cleaned);
    } catch (error) {
      logger.error("AUTH", "Failed to parse JSON. Raw content preview:", rawContent.slice(0, 200));
      throw error;
    }

    if (!Array.isArray(cookiesList)) {
      throw new Error("Cookies must be a JSON array");
    }

    const tokenCookie = cookiesList.find(c => c.name === "token");
    const oauthCookie = cookiesList.find(c => c.name === "oauth_id_token");

    if (!tokenCookie || !tokenCookie.value) {
      throw new Error("Could not find cookie named 'token' in the JSON array");
    }

    const token = tokenCookie.value;
    const tokenPayload = decodeJwtPayload(token);
    if (!tokenPayload) {
      throw new Error("Failed to decode token JWT");
    }

    const accountId = tokenPayload.id ?? tokenPayload.sub;
    const email = tokenPayload.email;

    if (!accountId || !email) {
      throw new Error("Could not extract id/email from token payload");
    }

    let displayName = null;
    if (oauthCookie && oauthCookie.value) {
      const oauthPayload = decodeJwtPayload(oauthCookie.value);
      if (oauthPayload && typeof oauthPayload.name === "string") {
        displayName = oauthPayload.name;
      }
    }

    const profileName = options.accountName || "imported";
    const profilePath = ensureDir(join(config.runtimeDir, "profiles", profileName));

    const localStorage: Record<string, string> = {
      token: token
    };
    if (oauthCookie && oauthCookie.value) {
      localStorage.oauth_id_token = oauthCookie.value;
    }

    const userAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

    const account = this.accounts.save({
      id: accountId,
      email,
      displayName,
      token,
      cookies: cookiesList,
      localStorage,
      browserProfilePath: profilePath,
      userAgent
    });

    logger.success("AUTH", `Successfully imported session for ${account.email} (${account.id})`);
  }
}
