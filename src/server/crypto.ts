import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ALGORITHM = "aes-256-gcm";

function keyFrom(base64Key: string): Buffer {
  const key = Buffer.from(base64Key, "base64");
  if (key.length !== 32) throw new Error("ENCRYPTION_KEY must be 32 bytes, base64 encoded");
  return key;
}

/** AES-256-GCM. Output: base64(iv | authTag | ciphertext). Used for integration tokens at rest. */
export function encryptJson(value: unknown, base64Key: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, keyFrom(base64Key), iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), data]).toString("base64");
}

export function decryptJson<T = unknown>(payload: string, base64Key: string): T {
  const raw = Buffer.from(payload, "base64");
  const decipher = createDecipheriv(ALGORITHM, keyFrom(base64Key), raw.subarray(0, 12));
  decipher.setAuthTag(raw.subarray(12, 28));
  const data = Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]);
  return JSON.parse(data.toString("utf8")) as T;
}
