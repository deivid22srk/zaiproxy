import type { ContentfulStatusCode } from "hono/utils/http-status";

export function openAIError(
  message: string,
  status: ContentfulStatusCode = 500,
  code = "server_error",
  type = "server_error"
) {
  return {
    status,
    body: {
      error: {
        message,
        type,
        param: null,
        code
      }
    }
  };
}
