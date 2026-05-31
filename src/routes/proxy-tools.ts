import { Hono } from "hono";
import { config } from "../config/env.js";
import { PROXY_TOOL_SPECS, proxyToolsRoot } from "../services/proxy-tools.js";
import { toolSpecsForPrompt } from "../services/tool-schema.js";

export function proxyToolRoutes(): Hono {
  const app = new Hono();

  app.get("/proxy/tools", (c) =>
    c.json({
      object: "list",
      enabled: config.tools.nativeEnabled,
      auto: config.tools.nativeAuto,
      root: proxyToolsRoot(),
      data: toolSpecsForPrompt(PROXY_TOOL_SPECS).map((tool) => ({
        type: "function",
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
          strict: true
        }
      }))
    })
  );

  return app;
}
