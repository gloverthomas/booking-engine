import type { Env } from "@/lib/env";
import { createLogger } from "@/lib/logger";
import type { McpOAuthConfig } from "./auth";

const log = createLogger("mcp-oauth");

/** Where Claude publishes the metadata document that identifies it as an OAuth client. */
export const DEFAULT_CLIENT_HOSTS = ["claude.ai", "claude.com"] as const;

/**
 * OAuth for the MCP is opt-in: it exists only when MCP_PUBLIC_URL (the canonical MCP URL) is set.
 * Throws on a URL that cannot be a protected resource, so a typo fails loudly instead of silently
 * issuing tokens nothing will accept.
 */
export function readMcpOAuthConfig(env: Pick<Env, "MCP_PUBLIC_URL" | "MCP_OAUTH_CLIENT_HOSTS">): McpOAuthConfig | undefined {
  const raw = env.MCP_PUBLIC_URL?.trim();
  if (!raw) return undefined;
  const url = new URL(raw);
  if (url.protocol !== "https:" || url.search || url.hash || url.username || url.password) {
    throw new Error("MCP_PUBLIC_URL must be an https URL with no query, fragment or credentials");
  }
  const hosts = (env.MCP_OAUTH_CLIENT_HOSTS ?? "")
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
  return {
    resource: url.origin + (url.pathname === "/" ? "" : url.pathname.replace(/\/$/, "")),
    clientHosts: hosts.length > 0 ? hosts : DEFAULT_CLIENT_HOSTS,
    onClientRefused: (clientIdUrl) => log({ level: "warn", event: "client_refused", clientIdUrl }),
  };
}
