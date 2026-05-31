export type ZaiAccount = {
  id: string;
  provider: "zai";
  email: string;
  displayName: string | null;
  token: string;
  cookies: unknown[];
  localStorage: Record<string, string>;
  browserProfilePath: string;
  userAgent: string;
  status: "active" | "invalid" | "disabled" | "limited";
  failureCount: number;
  lastError: string | null;
  limitedUntil: string | null;
  createdAt: string;
  updatedAt: string;
  lastLoginAt: string | null;
  lastValidatedAt: string | null;
};

export type ZaiCompletionEvent = {
  type?: string;
  error?: ZaiCompletionError;
  data?: {
    data?: {
      done?: boolean;
      error?: ZaiCompletionError;
    };
    delta_content?: string;
    phase?: "thinking" | "answer" | "other" | "done" | string;
    done?: boolean;
    error?: ZaiCompletionError;
    usage?: {
      prompt_tokens?: number;
      completion_tokens?: number;
      total_tokens?: number;
      prompt_tokens_details?: Record<string, unknown>;
    };
  };
};

export type ZaiCompletionError = {
  code?: string;
  detail?: string;
  message?: string;
  error_code?: string;
  captcha_error_type?: string;
};
