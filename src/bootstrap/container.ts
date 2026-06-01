import { AccountRepository } from "../db/accounts.js";
import { ConversationRepository } from "../db/conversations.js";
import { openDatabase } from "../db/database.js";
import { ResponseRepository } from "../db/responses.js";
import { config, loadOrCreateMasterSecret } from "../config/env.js";
import { CryptoBox } from "../lib/crypto.js";
import { logger } from "../lib/logger.js";

export type AppContainer = ReturnType<typeof createContainer>;

export function createContainer() {
  logger.info("BOOT", "Loading runtime configuration");
  logger.table("CONFIG", "runtime", [
    { key: "listen", value: `${config.host}:${config.port}` },
    { key: "zai_base", value: config.zai.baseUrl },
    { key: "captcha", value: config.captcha.headless ? "headless" : "visible" },
    { key: "proxy_tools", value: config.tools.nativeEnabled ? `enabled:${config.tools.nativeAuto ? "auto" : "manual"}` : "off" },
    { key: "tool_root", value: config.tools.root }
  ]);

  const crypto = new CryptoBox(loadOrCreateMasterSecret());
  const db = openDatabase();
  const accounts = new AccountRepository(db, crypto);
  const conversations = new ConversationRepository(db);
  const responses = new ResponseRepository(db);

  return {
    config,
    crypto,
    db,
    accounts,
    conversations,
    responses
  };
}
