import { createContainer } from "../bootstrap/container.js";
import { SessionBootstrap } from "../services/session-bootstrap.js";
import { logger } from "../lib/logger.js";

async function main(): Promise<void> {
  const container = createContainer();
  const bootstrap = new SessionBootstrap(container.accounts);
  await bootstrap.run(parseArgs(process.argv.slice(2)));
}

main().catch((error) => {
  logger.error("BOOT", error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

function parseArgs(args: string[]) {
  const options: {
    accountName?: string;
    allowGuest?: boolean;
    freshProfile?: boolean;
    reuseProfile?: boolean;
    cookies?: string;
  } = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg) {
      continue;
    }
    if (arg === "--account" || arg === "--profile") {
      const value = args[index + 1];
      if (value) {
        options.accountName = value;
      }
      index += 1;
    } else if (arg.startsWith("--account=")) {
      options.accountName = arg.slice("--account=".length);
    } else if (arg.startsWith("--profile=")) {
      options.accountName = arg.slice("--profile=".length);
    } else if (arg === "--allow-guest") {
      options.allowGuest = true;
    } else if (arg === "--fresh" || arg === "--new") {
      options.freshProfile = true;
    } else if (arg === "--reuse-profile") {
      options.reuseProfile = true;
    } else if (arg === "--cookies") {
      const value = args[index + 1];
      if (value) {
        options.cookies = value;
      }
      index += 1;
    } else if (arg.startsWith("--cookies=")) {
      options.cookies = arg.slice("--cookies=".length);
    } else if (!arg.startsWith("-")) {
      // Treat positional argument as cookies source if it is not a flag
      options.cookies = arg;
    }
  }
  return options;
}
