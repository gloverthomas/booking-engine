import { getDb } from "@/db/client";
import { getEnv } from "@/lib/env";
import { systemClock } from "../clock";
import { bearerAuthenticatorFromEnv, type McpAuthenticator } from "./auth";
import { loadMcpConfig } from "./config";
import { realServices, type McpDeps } from "./deps";
import { McpToolError } from "./errors";
import { createMcpRouteHandlers } from "./http";
import { createRateLimiter } from "./rate-limit";

export interface DefaultHandlerOptions {
  /**
   * Replace the interim bearer-token check, e.g. with an OAuth 2.1 verifier. Return null to fail closed.
   * Defaults to MCP_API_TOKEN_HASH / MCP_API_TOKEN from the environment.
   */
  getAuthenticator?: () => McpAuthenticator | null;
  resourceMetadataUrl?: string;
}

/** Wire the route to the real database, real domain functions and the environment. */
export function createDefaultMcpHandlers(options: DefaultHandlerOptions = {}) {
  let config: ReturnType<typeof loadMcpConfig> | undefined;
  const settings = () => (config ??= loadMcpConfig());
  const limiters: {
    requests?: ReturnType<typeof createRateLimiter>;
    writes?: ReturnType<typeof createRateLimiter>;
    failed?: ReturnType<typeof createRateLimiter>;
  } = {};
  const requests = () =>
    (limiters.requests ??= createRateLimiter({
      limit: settings().requestsPerMinute,
      windowMs: 60_000,
    }));
  const writes = () =>
    (limiters.writes ??= createRateLimiter({
      limit: settings().writesPerMinute,
      windowMs: 60_000,
    }));
  const failed = () => (limiters.failed ??= createRateLimiter({ limit: 10, windowMs: 60_000 }));

  return createMcpRouteHandlers({
    getAuthenticator: options.getAuthenticator ?? (() => bearerAuthenticatorFromEnv()),
    resourceMetadataUrl: options.resourceMetadataUrl,
    requestLimiter: { check: (key) => requests().check(key) },
    failedAuthLimiter: { check: (key) => failed().check(key) },
    getDeps: (): McpDeps => ({
      db: getDb(),
      services: realServices,
      config: settings(),
      getConfirmSecret: () => {
        const key = getEnv().ENCRYPTION_KEY;
        if (!key) {
          throw new McpToolError(
            "precondition_failed",
            "Changes through Claude are unavailable: the server has no ENCRYPTION_KEY configured.",
          );
        }
        return key;
      },
      now: systemClock,
      writeLimiter: { check: (key) => writes().check(key) },
    }),
  });
}
