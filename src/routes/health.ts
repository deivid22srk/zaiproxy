import { Hono } from "hono";
import type { ZaiClient } from "../services/zai-client.js";

export function healthRoutes(zai: ZaiClient): Hono {
  const app = new Hono();

  app.get("/", async (c) => {
    const upstream = await zai.health();
    return c.json(
      {
        status: upstream.ok ? "ok" : "degraded",
        service: "glm-zai-proxy",
        upstream,
        timestamp: new Date().toISOString()
      },
      upstream.ok ? 200 : 503
    );
  });

  return app;
}
