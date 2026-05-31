import { createHmac } from "node:crypto";

const SIGNATURE_KEY = "key-@@@@)))()((9))-xxxx&&&%%%%%";

function hmacSha256(key: string, value: string): string {
  return createHmac("sha256", key).update(value).digest("hex");
}

export function sortedSignaturePayload(base: Record<string, string>): string {
  return Object.entries(base)
    .sort(([left], [right]) => left.localeCompare(right))
    .join(",");
}

export function computeZaiSignature(
  sortedPayload: string,
  signaturePrompt: string,
  timestamp: string
): string {
  const promptBase64 = Buffer.from(signaturePrompt, "utf8").toString("base64");
  const payload = `${sortedPayload}|${promptBase64}|${timestamp}`;
  const timeBucket = Math.floor(Number(timestamp) / (5 * 60 * 1000));
  const derivedKey = hmacSha256(SIGNATURE_KEY, String(timeBucket));
  return hmacSha256(derivedKey, payload);
}
