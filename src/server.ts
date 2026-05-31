import { serve } from "@hono/node-server";
import { createContainer } from "./bootstrap/container.js";
import { createApp } from "./app.js";
import { logger } from "./lib/logger.js";

const container = createContainer();
const app = createApp(container);

serve(
  {
    fetch: app.fetch,
    hostname: container.config.host,
    port: container.config.port
  },
  (info) => {
    logger.success("BOOT", `Proxy listening on http://${info.address}:${info.port}`);
  }
);
