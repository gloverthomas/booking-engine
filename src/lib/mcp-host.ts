/**
 * The MCP server's own hostname. It is the same Next.js service as the app, reached on a second domain,
 * so `https://mcp.hairmate.world/mcp` and `https://app.hairmate.world/api/mcp` are the same endpoint.
 *
 * Wire into next.config.ts:
 *
 *   async rewrites() { return { beforeFiles: mcpHostRewrites() }; }
 *
 * On this host only /mcp is served. Everything else (login, admin, booking, API) gets the not-found page,
 * so the connector domain does not double as a second front door to the app.
 */

export const MCP_HOST = "mcp.hairmate.world";

/** Where requests for the MCP host's other paths are sent. No page exists there, so Next answers 404. */
const NOT_FOUND_PATH = "/mcp-host-only";

export interface HostRewrite {
  source: string;
  has: Array<{ type: "host"; value: string }>;
  destination: string;
}

export function mcpHostRewrites(): HostRewrite[] {
  const has = [{ type: "host" as const, value: MCP_HOST }];
  return [
    { source: "/mcp", has, destination: "/api/mcp" },
    // Everything except /mcp and the two paths above, so the rules cannot rewrite their own output.
    {
      source: "/:path((?!mcp$|api/mcp$|mcp-host-only$).*)",
      has,
      destination: NOT_FOUND_PATH,
    },
  ];
}
