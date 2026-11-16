import { oauthProviderAuthServerMetadata } from "@better-auth/oauth-provider";
import { connection } from "next/server";
import { getAuth } from "@/server/auth";

/**
 * RFC 8414 discovery for the OAuth authorization server (Better Auth at /api/auth), at the root path form MCP
 * clients look for. Better Auth cannot serve it there itself because its own routes live under /api/auth.
 * Answers 404 while OAuth is off (MCP_PUBLIC_URL unset), when no OAuth endpoints exist.
 */
export async function GET(request: Request): Promise<Response> {
  // Per request, never at build time: the auth environment may not exist while building.
  await connection();
  const auth = getAuth();
  if (!auth.options.plugins?.some((plugin) => plugin.id === "oauth-provider")) {
    return new Response("Not found", { status: 404 });
  }
  return oauthProviderAuthServerMetadata(auth as never)(request);
}
