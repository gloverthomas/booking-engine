import { eq } from "drizzle-orm";
import { user } from "@/db/auth-schema";
import type { Env } from "@/lib/env";
import { MCP_SCOPE } from "@/server/auth/auth";
import { isOwnerEmail, parseOwnerEmails } from "@/server/auth/owners";
import type { Db } from "@/server/db-types";
import type { McpAuthenticator } from "./auth";
import {
  createOAuthAuthenticator,
  protectedResourceMetadata,
  protectedResourceMetadataUrl,
} from "./oauth";

type OAuthEnv = Pick<Env, "MCP_PUBLIC_URL" | "APP_URL" | "OWNER_EMAILS">;

/** Better Auth is mounted at /api/auth, and its issuer is that URL. */
const AUTH_BASE_PATH = "/api/auth";

export interface McpOAuthEndpoints {
  resource: string;
  issuer: string;
  jwksUrl: string;
  /** Where clients fetch the protected-resource document; advertised in WWW-Authenticate. */
  metadataUrl: string;
}

/** The OAuth URLs for this deployment, or null while OAuth is off (MCP_PUBLIC_URL unset). */
export function mcpOAuthEndpoints(env: Pick<Env, "MCP_PUBLIC_URL" | "APP_URL">): McpOAuthEndpoints | null {
  const resource = env.MCP_PUBLIC_URL?.trim();
  if (!resource || !env.APP_URL) return null;
  const issuer = `${new URL(env.APP_URL).origin}${AUTH_BASE_PATH}`;
  return {
    resource,
    issuer,
    jwksUrl: `${issuer}/jwks`,
    metadataUrl: protectedResourceMetadataUrl(resource),
  };
}

/** The protected-resource document for this deployment, or null while OAuth is off. */
export function mcpProtectedResourceDocument(env: Pick<Env, "MCP_PUBLIC_URL" | "APP_URL">) {
  const endpoints = mcpOAuthEndpoints(env);
  if (!endpoints) return null;
  return protectedResourceMetadata({
    resource: endpoints.resource,
    issuer: endpoints.issuer,
    scope: MCP_SCOPE,
  });
}

/** Authenticator for OAuth access tokens, or null while OAuth is off. Owners only, re-checked on every request. */
export function oauthAuthenticatorFromEnv(env: OAuthEnv, db: Db): McpAuthenticator | null {
  const endpoints = mcpOAuthEndpoints(env);
  if (!endpoints) return null;
  return createOAuthAuthenticator({
    issuer: endpoints.issuer,
    resource: endpoints.resource,
    jwksUrl: endpoints.jwksUrl,
    scope: MCP_SCOPE,
    isOwner: async (userId) => {
      const [row] = await db.select({ email: user.email }).from(user).where(eq(user.id, userId));
      return isOwnerEmail(row?.email, parseOwnerEmails(env.OWNER_EMAILS));
    },
  });
}
