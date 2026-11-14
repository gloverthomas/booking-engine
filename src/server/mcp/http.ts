import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { createLogger } from "@/lib/logger";
import type { McpAuthenticator } from "./auth";
import type { McpDeps } from "./deps";
import type { RateLimiter } from "./rate-limit";
import { createMcpServer } from "./server";

const log = createLogger("mcp");
const MAX_BODY_BYTES = 256 * 1024;

export interface McpRouteOptions {
  /** Returns null when nothing is configured, so the route fails closed (503) instead of allowing anyone in. */
  getAuthenticator: () => McpAuthenticator | null;
  getDeps: () => McpDeps;
  /** Every authenticated request, per token. */
  requestLimiter: RateLimiter;
  /** Failed authentication attempts, per client address. */
  failedAuthLimiter: RateLimiter;
  /**
   * For OAuth: URL of the protected-resource metadata document, advertised in WWW-Authenticate so MCP clients
   * can discover the authorization server. Unused by the bearer-token authenticator.
   */
  resourceMetadataUrl?: string;
}

function jsonError(
  status: number,
  code: number,
  message: string,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: null }), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...headers },
  });
}

function clientAddress(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  return forwarded?.split(",")[0]?.trim() || request.headers.get("x-real-ip") || "unknown";
}

/**
 * Framework-neutral handlers for the /api/mcp route: authenticate, rate limit, then hand the request to a fresh
 * stateless Streamable HTTP transport and server. Takes any McpAuthenticator, so OAuth can replace the bearer
 * token without changes here.
 */
export function createMcpRouteHandlers(options: McpRouteOptions) {
  const challenge = (): string =>
    options.resourceMetadataUrl
      ? `Bearer realm="booking-engine-mcp", resource_metadata="${options.resourceMetadataUrl}"`
      : 'Bearer realm="booking-engine-mcp"';

  async function POST(request: Request): Promise<Response> {
    const authenticator = options.getAuthenticator();
    if (!authenticator) {
      log({ level: "error", event: "mcp.not_configured" });
      return jsonError(503, -32000, "The MCP server is not configured.");
    }

    const principal = await authenticator.authenticate(request);
    if (!principal) {
      const attempt = options.failedAuthLimiter.check(clientAddress(request));
      if (!attempt.allowed) {
        return jsonError(429, -32000, "Too many failed attempts.", {
          "retry-after": String(attempt.retryAfterSec),
        });
      }
      return jsonError(401, -32001, "Authentication required.", {
        "www-authenticate": challenge(),
      });
    }

    const limit = options.requestLimiter.check(principal.tokenId ?? principal.ownerId);
    if (!limit.allowed) {
      return jsonError(429, -32000, "Rate limit exceeded.", {
        "retry-after": String(limit.retryAfterSec),
      });
    }

    // Stateless: a new transport and server for every request, nothing shared between callers.
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
      maxRequestBodySize: MAX_BODY_BYTES,
    });
    const server = createMcpServer(options.getDeps(), principal);
    try {
      await server.connect(transport);
      return await transport.handleRequest(request);
    } finally {
      void server.close().catch(() => undefined);
    }
  }

  /** Stateless servers have no sessions to resume or end. */
  async function methodNotAllowed(): Promise<Response> {
    return jsonError(405, -32000, "Method not allowed. Use POST.", { allow: "POST" });
  }

  return { POST, GET: methodNotAllowed, DELETE: methodNotAllowed };
}
