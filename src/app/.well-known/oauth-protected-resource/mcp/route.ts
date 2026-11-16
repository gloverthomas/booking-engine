import { connection } from "next/server";
import { getEnv } from "@/lib/env";
import { mcpProtectedResourceDocument } from "@/server/mcp/oauth-runtime";

/**
 * RFC 9728 document: tells an MCP client which authorization server issues tokens for the MCP URL. Served on
 * the MCP host as well as the app host. Answers 404 while OAuth is off (MCP_PUBLIC_URL unset).
 */
export async function GET(): Promise<Response> {
  await connection();
  const document = mcpProtectedResourceDocument(getEnv());
  if (!document) return new Response("Not found", { status: 404 });
  return Response.json(document, {
    headers: { "cache-control": "public, max-age=300", "access-control-allow-origin": "*" },
  });
}
