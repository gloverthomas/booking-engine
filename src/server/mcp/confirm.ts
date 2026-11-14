import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/** Deterministic JSON: object keys sorted, undefined dropped. Two equal argument sets always serialise identically. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object" && !(value instanceof Date)) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => [k, sortKeys(v)]),
    );
  }
  return value;
}

function subkey(base64Secret: string): Buffer {
  const raw = Buffer.from(base64Secret, "base64");
  if (raw.length !== 32) throw new Error("ENCRYPTION_KEY must be 32 bytes, base64 encoded");
  // Domain separation: this key can never forge tokens used by other modules.
  return createHmac("sha256", raw).update("booking-engine/mcp-confirm/v1").digest();
}

function macFor(
  secret: string,
  input: { tool: string; ownerId: string; expiresAt: number; nonce: string; args: unknown },
): Buffer {
  return createHmac("sha256", subkey(secret))
    .update(
      JSON.stringify([
        input.tool,
        input.ownerId,
        input.expiresAt,
        input.nonce,
        canonicalJson(input.args),
      ]),
    )
    .digest();
}

export interface ConfirmTokenInput {
  /** base64 ENCRYPTION_KEY. */
  secret: string;
  tool: string;
  ownerId: string;
  /** The validated, normalised arguments the preview was generated for (without the token itself). */
  args: unknown;
  now: Date;
}

/** Short-lived token proving "this exact call was previewed". Format: v1.<expiryMs>.<nonce>.<hmac>. */
export function createConfirmToken(input: ConfirmTokenInput & { ttlMs: number }): {
  token: string;
  expiresAt: Date;
} {
  const expiresAt = input.now.getTime() + input.ttlMs;
  const nonce = randomBytes(9).toString("base64url");
  const mac = macFor(input.secret, { ...input, expiresAt, nonce }).toString("base64url");
  return { token: `v1.${expiresAt}.${nonce}.${mac}`, expiresAt: new Date(expiresAt) };
}

export type ConfirmVerdict =
  { ok: true; tokenId: string } | { ok: false; reason: "malformed" | "invalid" | "expired" };

/**
 * Valid only for the same tool, owner and exactly the same arguments, before it expires.
 * Any other argument (even whitespace in a note) produces "invalid".
 */
export function verifyConfirmToken(input: ConfirmTokenInput & { token: string }): ConfirmVerdict {
  const parts = input.token.split(".");
  if (parts.length !== 4 || parts[0] !== "v1") return { ok: false, reason: "malformed" };
  const [, expiry, nonce, mac] = parts;
  const expiresAt = Number(expiry);
  if (!Number.isSafeInteger(expiresAt) || !/^[\w-]{1,32}$/.test(nonce)) {
    return { ok: false, reason: "malformed" };
  }
  const expected = macFor(input.secret, { ...input, expiresAt, nonce });
  const presented = Buffer.from(mac, "base64url");
  if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) {
    return { ok: false, reason: "invalid" };
  }
  if (input.now.getTime() > expiresAt) return { ok: false, reason: "expired" };
  return { ok: true, tokenId: createHash("sha256").update(input.token).digest("hex") };
}
