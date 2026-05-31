import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

const ALGORITHM = "aes-256-gcm";

function keyFromSecret(secret: string): Buffer {
  const trimmed = secret.trim();
  try {
    const decoded = Buffer.from(trimmed, "base64");
    if (decoded.length === 32) {
      return decoded;
    }
  } catch {
    // Fall through to hashing passphrases.
  }
  return createHash("sha256").update(trimmed).digest();
}

export class CryptoBox {
  private readonly key: Buffer;

  constructor(secret: string) {
    this.key = keyFromSecret(secret);
  }

  encrypt(value: unknown): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv(ALGORITHM, this.key, iv);
    const plaintext = Buffer.from(JSON.stringify(value), "utf8");
    const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();
    return ["v1", iv.toString("base64"), tag.toString("base64"), encrypted.toString("base64")].join(":");
  }

  decrypt<T>(payload: string): T {
    const [version, iv, tag, encrypted] = payload.split(":");
    if (version !== "v1" || !iv || !tag || !encrypted) {
      throw new Error("Invalid encrypted payload");
    }

    const decipher = createDecipheriv(ALGORITHM, this.key, Buffer.from(iv, "base64"));
    decipher.setAuthTag(Buffer.from(tag, "base64"));
    const decrypted = Buffer.concat([
      decipher.update(Buffer.from(encrypted, "base64")),
      decipher.final()
    ]);
    return JSON.parse(decrypted.toString("utf8")) as T;
  }
}
