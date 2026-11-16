import type { Env } from "@/lib/env";
import type { Db } from "@/server/db-types";
import type { AuthConfig } from "./auth";
import { parseOwnerEmails } from "./owners";
import { isActiveStaffEmail } from "./resolve-access";
import { readMcpOAuthConfig } from "./mcp-oauth-config";

/** Sign-in cannot work until the environment is filled in. Distinct so the API can say so plainly (503). */
export class AuthNotConfiguredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthNotConfiguredError";
  }
}

const REQUIRED = [
  ["BETTER_AUTH_SECRET", "a random 32+ character secret (openssl rand -base64 32)"],
  ["APP_URL", "the public origin of this app, e.g. https://admin.example.com"],
  ["GOOGLE_CLIENT_ID", "the Google OAuth client id"],
  ["GOOGLE_CLIENT_SECRET", "the Google OAuth client secret"],
  ["OWNER_EMAILS", "a comma-separated list of emails allowed to sign in"],
] as const;

/**
 * Turns the validated environment into Better Auth config. Called lazily (first admin request),
 * never at import time, and fails with one message naming every missing key.
 */
export function readAuthConfig(env: Env, db: Db): AuthConfig {
  const missing = REQUIRED.filter(([key]) => !env[key]);
  if (missing.length > 0) {
    const list = missing.map(([key, hint]) => `${key} (${hint})`).join("; ");
    throw new AuthNotConfiguredError(`Admin sign-in is not configured. Set: ${list}`);
  }
  const secret = env.BETTER_AUTH_SECRET as string;
  if (secret.length < 32) {
    throw new AuthNotConfiguredError("BETTER_AUTH_SECRET must be at least 32 characters");
  }
  const baseURL = new URL(env.APP_URL as string).origin;
  const ownerEmails = parseOwnerEmails(env.OWNER_EMAILS);
  if (ownerEmails.size === 0) {
    throw new AuthNotConfiguredError("OWNER_EMAILS must list at least one email address");
  }
  return {
    db,
    secret,
    baseURL,
    google: {
      // The web client comes first (it runs the browser flow); the iOS client is accepted for ID tokens only.
      clientId: env.GOOGLE_IOS_CLIENT_ID
        ? [env.GOOGLE_CLIENT_ID as string, env.GOOGLE_IOS_CLIENT_ID]
        : (env.GOOGLE_CLIENT_ID as string),
      clientSecret: env.GOOGLE_CLIENT_SECRET as string,
    },
    // Re-parsed each call so a changed environment (tests, restarts) is honoured, and so it is never stale.
    ownerEmails: () => parseOwnerEmails(env.OWNER_EMAILS),
    isStaffEmail: (email) => isActiveStaffEmail(db, email),
    secureCookies: env.NODE_ENV === "production" || baseURL.startsWith("https://"),
    mcpOAuth: readMcpOAuthConfig(env),
  };
}
