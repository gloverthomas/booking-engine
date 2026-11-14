import { createDefaultMcpHandlers } from "@/server/mcp/runtime";

/**
 * Remote MCP server (Streamable HTTP, stateless). Connect it to Claude as a custom connector at /api/mcp.
 * Authentication is pluggable: pass `getAuthenticator` here to swap the interim bearer token for OAuth 2.1.
 */
const handlers = createDefaultMcpHandlers();

export const POST = handlers.POST;
export const GET = handlers.GET;
export const DELETE = handlers.DELETE;
