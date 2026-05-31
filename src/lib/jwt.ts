export type DecodedJwt = {
  id?: string;
  sub?: string;
  email?: string;
  name?: string;
  [key: string]: unknown;
};

export function decodeJwtPayload(token: string): DecodedJwt | null {
  const [, payload] = token.split(".");
  if (!payload) {
    return null;
  }

  const normalized = payload.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  try {
    return JSON.parse(Buffer.from(padded, "base64").toString("utf8")) as DecodedJwt;
  } catch {
    return null;
  }
}
