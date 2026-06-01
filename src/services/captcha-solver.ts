import { logger } from "../lib/logger.js";
import type { ZaiAccount } from "../types/zai.js";

export class CaptchaSolver {
  async solve(account: ZaiAccount): Promise<string> {
    logger.error("AUTH", "Captcha solving requested, but Playwright is disabled in this environment.");
    throw new Error("FRONTEND_CAPTCHA_REQUIRED: Playwright is disabled, cannot solve captcha automatically.");
  }
}
