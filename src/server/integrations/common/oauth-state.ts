import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { decryptJson, encryptJson } from "@/server/crypto";

/**
 * CSRF protection for the OAuth round trip. `connect` generates a random `state` (and a PKCE
 * verifier) and keeps them in a short-lived, httpOnly, encrypted cookie. `callback` only
 * proceeds when the `state` query parameter matches the cookie.
 */

export type OAuthProvider = "google" | "xero";

export interface OAuthTransaction {
  provider: OAuthProvider;
  state: string;
  codeVerifier: string;
  /** Epoch ms after which the transaction is rejected. */
  expiresAt: number;
  /** Caller-defined values to carry across the redirect (e.g. the chosen calendar id). */
  extra: Record<string, string>;
}

export class OAuthStateError extends Error {}

export const OAUTH_TTL_MS = 10 * 60 * 1000;

export const oauthCookieName = (provider: OAuthProvider): string => `be_oauth_${provider}`;
export const oauthCookiePath = (provider: OAuthProvider): string => `/api/integrations/${provider}`;

const base64Url = (buffer: Buffer): string => buffer.toString("base64url");

export function pkceChallenge(verifier: string): string {
  return base64Url(createHash("sha256").update(verifier).digest());
}

export interface BeginOAuthInput {
  provider: OAuthProvider;
  key: string;
  now: Date;
  extra?: Record<string, string>;
  ttlMs?: number;
}

export interface BegunOAuth {
  state: string;
  codeVerifier: string;
  codeChallenge: string;
  /** Encrypted cookie value to set. */
  cookieValue: string;
}

export function beginOAuth(input: BeginOAuthInput): BegunOAuth {
  const state = base64Url(randomBytes(24));
  const codeVerifier = base64Url(randomBytes(32));
  const transaction: OAuthTransaction = {
    provider: input.provider,
    state,
    codeVerifier,
    expiresAt: input.now.getTime() + (input.ttlMs ?? OAUTH_TTL_MS),
    extra: input.extra ?? {},
  };
  return {
    state,
    codeVerifier,
    codeChallenge: pkceChallenge(codeVerifier),
    cookieValue: encryptJson(transaction, input.key),
  };
}

export interface CompleteOAuthInput {
  provider: OAuthProvider;
  key: string;
  now: Date;
  cookieValue: string | undefined;
  stateParam: string | null;
}

/** Validates the callback against the cookie. Throws OAuthStateError on any mismatch. */
export function completeOAuth(input: CompleteOAuthInput): OAuthTransaction {
  if (!input.cookieValue || !input.stateParam) {
    throw new OAuthStateError("Missing OAuth state. Start the connection again.");
  }
  let transaction: OAuthTransaction;
  try {
    transaction = decryptJson<OAuthTransaction>(input.cookieValue, input.key);
  } catch {
    throw new OAuthStateError("OAuth state could not be verified. Start the connection again.");
  }
  const expected = Buffer.from(transaction.state);
  const actual = Buffer.from(input.stateParam);
  const matches = expected.length === actual.length && timingSafeEqual(expected, actual);
  if (!matches || transaction.provider !== input.provider) {
    throw new OAuthStateError("OAuth state mismatch. Start the connection again.");
  }
  if (transaction.expiresAt < input.now.getTime()) {
    throw new OAuthStateError("The connection attempt expired. Start the connection again.");
  }
  return transaction;
}

export interface CookieOptions {
  maxAgeSec: number;
  path: string;
  secure: boolean;
}

export function serializeCookie(name: string, value: string, options: CookieOptions): string {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    `Path=${options.path}`,
    `Max-Age=${options.maxAgeSec}`,
    "HttpOnly",
    "SameSite=Lax",
  ];
  if (options.secure) parts.push("Secure");
  return parts.join("; ");
}

export function readCookie(header: string | null, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const [rawName, ...rest] = part.trim().split("=");
    if (rawName === name) return decodeURIComponent(rest.join("="));
  }
  return undefined;
}
