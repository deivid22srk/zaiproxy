export function upstreamStatus(message: string): 401 | 429 | 502 {
  if (/cooldown|cooling down|try again soon|rate.?limit|too many|quota|usage exceeds/i.test(message)) {
    return 429;
  }
  if (/No usable|No active|login|auth|unauthorized|invalid token|token expired/i.test(message)) {
    return 401;
  }
  return 502;
}

export function upstreamErrorCode(status: number): string {
  if (status === 429) {
    return "rate_limit_exceeded";
  }
  if (status === 401) {
    return "invalid_api_key";
  }
  return "upstream_error";
}
