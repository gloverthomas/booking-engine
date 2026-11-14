import { createHash, timingSafeEqual } from "node:crypto";
import { MCP_ENV } from "./config";

/** Who is calling. Every write is audited with actor "mcp". */
export interface McpPrincipal {
  actor: "mcp";
  ownerId: string;
  /** Non-secret identifier of the credential used (for rate limiting and logs). Defaults to ownerId. */
  tokenId?: string;
}

/**
 * Port for authenticating an incoming MCP request. The route accepts any implementation, so the bearer-token
 * one below can be swapped for OAuth 2.1 (better-auth's MCP plugin) without touching the server or tools.
 * Return null for "not authenticated"; never throw for bad credentials.
 */
export interface McpAuthenticator {
  authenticate(request: Request): Promise<McpPrincipal | null> | McpPrincipal | null;
}

export const hashToken = (token: string): string =>
  createHash("sha256").update(token).digest("hex");

const SHA256_HEX = /^[0-9a-f]{64}$/;
export const MIN_RAW_TOKEN_LENGTH = 32;

export interface BearerAuthOptions {
  /** SHA-256 hex digests of the accepted tokens (more than one allows rotation). */
  tokenHashes: readonly string[];
  ownerId: string;
}

export function bearerTokenFrom(request: Request): string | null {
  const header = request.headers.get("authorization");
  const match = header ? /^Bearer\s+(\S+)$/i.exec(header.trim()) : null;
  return match ? match[1] : null;
}

/** Bearer token compared (constant time) against stored SHA-256 digests, never against a plaintext token. */
export function createBearerAuthenticator(options: BearerAuthOptions): McpAuthenticator {
  const accepted = options.tokenHashes.map((h) => ({
    digest: Buffer.from(h.toLowerCase(), "hex"),
    id: h.slice(0, 12).toLowerCase(),
  }));
  return {
    authenticate(request) {
      const presented = bearerTokenFrom(request);
      if (!presented) return null;
      const presentedDigest = Buffer.from(hashToken(presented), "hex");
      let matched: string | null = null;
      for (const candidate of accepted) {
        // No early exit: every candidate is compared so timing does not reveal which one matched.
        if (timingSafeEqual(candidate.digest, presentedDigest)) matched = candidate.id;
      }
      return matched ? { actor: "mcp", ownerId: options.ownerId, tokenId: matched } : null;
    },
  };
}

/**
 * Build the interim authenticator from env. Prefer MCP_API_TOKEN_HASH (comma separated SHA-256 hex digests:
 * `printf %s "$TOKEN" | shasum -a 256`), so the server never holds the secret. MCP_API_TOKEN (the raw token,
 * at least 32 characters) is also accepted and hashed in memory. Returns null when neither is set, so the
 * route fails closed.
 */
export function bearerAuthenticatorFromEnv(
  env: Record<string, string | undefined> = process.env,
): McpAuthenticator | null {
  const hashes = (env[MCP_ENV.tokenHash] ?? "")
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
  for (const h of hashes) {
    if (!SHA256_HEX.test(h)) {
      throw new Error(`${MCP_ENV.tokenHash} must be comma separated SHA-256 hex digests`);
    }
  }
  const raw = (env[MCP_ENV.token] ?? "").trim();
  if (raw) {
    if (raw.length < MIN_RAW_TOKEN_LENGTH) {
      throw new Error(`${MCP_ENV.token} must be at least ${MIN_RAW_TOKEN_LENGTH} characters`);
    }
    hashes.push(hashToken(raw));
  }
  if (hashes.length === 0) return null;
  return createBearerAuthenticator({
    tokenHashes: hashes,
    ownerId: env[MCP_ENV.ownerId]?.trim() || "owner",
  });
}
