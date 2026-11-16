import { cimd } from "@better-auth/cimd";
import { fetchClientMetadataResource } from "@better-auth/cimd/node";
import { mcp } from "@better-auth/mcp";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { nextCookies } from "better-auth/next-js";
import { bearer, jwt } from "better-auth/plugins";
import { eq } from "drizzle-orm";
import * as authSchema from "@/db/auth-schema";
import type { Db } from "@/server/db-types";
import { evaluateIdentityWithStaff } from "./owners";

const SESSION_DAYS = 30;
const SESSION_REFRESH_AFTER_HOURS = 24;

export interface AuthConfig {
  /** Any Drizzle Postgres database that has the auth tables (node-postgres in prod, PGlite in tests). */
  db: Db;
  secret: string;
  /** Public origin of the app, e.g. https://admin.example.com. Also the only trusted origin. */
  baseURL: string;
  google: { clientId: string | string[]; clientSecret: string };
  /** Read on every sign-in and session creation, so allow-list changes apply immediately. */
  ownerEmails: () => ReadonlySet<string>;
  /** True for an email that belongs to an active staff member. Read on every sign-in too. Omitted = owners only. */
  isStaffEmail?: (email: string) => Promise<boolean>;
  secureCookies: boolean;
  /**
   * Lets Claude (and other MCP clients) sign in to the MCP server with OAuth 2.1. Omitted = the MCP only
   * accepts the static bearer token, and no OAuth endpoints exist.
   */
  mcpOAuth?: McpOAuthConfig;
}

export interface McpOAuthConfig {
  /** Canonical URL of the MCP endpoint, e.g. https://mcp.hairmate.world/mcp. Tokens are bound to it. */
  resource: string;
  /** Hostnames whose published client metadata may identify a client (e.g. claude.ai). Anything else is refused. */
  clientHosts: readonly string[];
  /** Called with the refused client_id URL, so a wrong allow-list is diagnosable from the logs. */
  onClientRefused?: (clientIdUrl: string) => void;
}

/** The one scope an MCP client is granted; the MCP route requires it on every token. */
export const MCP_SCOPE = "mcp";
/** Short on purpose: access tokens cannot be revoked, only expire. Refresh tokens carry the session. */
export const MCP_ACCESS_TOKEN_SECONDS = 15 * 60;
const MCP_REFRESH_TOKEN_SECONDS = 30 * 24 * 60 * 60;

/**
 * Better Auth with Google as the only way in, gated by the allow-list: OWNER_EMAILS plus active staff.
 *
 * Defence in depth, because letting a stranger into the admin is the one thing that must not happen:
 *  1. `user.validateUserInfo` rejects identities outside the allow-list before any account is created or linked.
 *  2. `databaseHooks.user.create.before` refuses to insert a user row for them.
 *  3. `databaseHooks.session.create.before` refuses to mint a session for someone no longer allowed in.
 *  4. `requireAccess()` re-resolves the person's staff row on every request (see guard.ts).
 */
export function createAuth(config: AuthConfig) {
  const isStaffEmail = config.isStaffEmail ?? (async () => false);
  const evaluate = (email: string | null | undefined, emailVerified?: boolean | null) =>
    evaluateIdentityWithStaff({ email, emailVerified }, config.ownerEmails(), isStaffEmail);
  const admits = async (email: string | null | undefined, emailVerified?: boolean | null) =>
    (await evaluate(email, emailVerified)) === null;

  return betterAuth({
    appName: "Ryan Kennedy Hairdressing Admin",
    baseURL: config.baseURL,
    secret: config.secret,
    // CSRF: Better Auth validates Origin/Fetch-Metadata against trustedOrigins. Keep it to our own origin.
    trustedOrigins: [config.baseURL],
    database: drizzleAdapter(config.db, { provider: "pg", schema: authSchema }),
    // Google only: no password or magic-link sign-in exists, so there is nothing to credential-stuff.
    emailAndPassword: { enabled: false },
    socialProviders: {
      google: {
        clientId: config.google.clientId,
        clientSecret: config.google.clientSecret,
        prompt: "select_account",
      },
    },
    account: {
      // Google tokens are only used to identify the owner; never keep them readable at rest.
      encryptOAuthTokens: true,
      accountLinking: { enabled: true, trustedProviders: ["google"] },
    },
    user: {
      validateUserInfo: async ({ user }) => {
        const rejection = await evaluate(user.email, user.emailVerified);
        return rejection ?? undefined;
      },
    },
    databaseHooks: {
      user: {
        create: {
          before: async (user) => {
            if (!(await admits(user.email, user.emailVerified))) return false;
          },
        },
      },
      session: {
        create: {
          before: async (session) => {
            const email = await lookupEmail(config.db, session.userId);
            if (!(await admits(email))) return false;
          },
        },
      },
    },
    session: {
      expiresIn: SESSION_DAYS * 24 * 60 * 60,
      updateAge: SESSION_REFRESH_AFTER_HOURS * 60 * 60,
      // No cookie cache: every request re-reads the session row so sign-out and revocation are immediate.
    },
    advanced: {
      cookiePrefix: "rk-admin",
      useSecureCookies: config.secureCookies,
      defaultCookieAttributes: {
        httpOnly: true,
        // Lax (not Strict) so the cookie survives the top-level redirect back from Google.
        sameSite: "lax",
        secure: config.secureCookies,
        path: "/",
      },
    },
    rateLimit: { enabled: true, window: 60, max: 30 },
    // bearer(): the iPhone app sends `Authorization: Bearer <token>` instead of a cookie. Same sessions, same
    // allow-list, same revocation. nextCookies() must stay last.
    plugins: [bearer(), ...mcpPlugins(config.mcpOAuth), nextCookies()],
    // jwt() would otherwise let any signed-in session mint a JWT at /token; only the OAuth flow issues tokens.
    ...(config.mcpOAuth ? { disabledPaths: ["/token"] } : {}),
  });
}

/**
 * OAuth 2.1 for the MCP server: Better Auth is the authorization server (the owner signs in with Google and
 * approves the connection on /consent), Claude identifies itself with a published metadata document (CIMD),
 * and tokens are short-lived JWTs bound to the MCP URL. No open client registration.
 */
function mcpPlugins(oauth: McpOAuthConfig | undefined) {
  if (!oauth) return [];
  const allowedHosts = new Set(oauth.clientHosts.map((h) => h.toLowerCase()));
  return [
    jwt({ disableSettingJwtHeader: true }),
    mcp({
      loginPage: "/login",
      consentPage: "/consent",
      resource: oauth.resource,
      scopes: [MCP_SCOPE, "offline_access"],
      accessTokenExpiresIn: MCP_ACCESS_TOKEN_SECONDS,
      refreshTokenExpiresIn: MCP_REFRESH_TOKEN_SECONDS,
    }),
    cimd({
      fetchClientMetadataResource,
      metadataProfile: "mcp-2026-07-28",
      isMetadataDocumentUrlAllowed: (clientIdUrl) => {
        const allowed = isAllowedClientUrl(clientIdUrl, allowedHosts);
        if (!allowed) oauth.onClientRefused?.(clientIdUrl);
        return allowed;
      },
    }),
  ];
}

/** True for an https URL on one of the allowed hosts (exact match, no subdomains, no credentials). */
export function isAllowedClientUrl(raw: string, allowedHosts: ReadonlySet<string>): boolean {
  try {
    const url = new URL(raw);
    return (
      url.protocol === "https:" &&
      url.username === "" &&
      url.password === "" &&
      allowedHosts.has(url.hostname.toLowerCase())
    );
  } catch {
    return false;
  }
}

export type Auth = ReturnType<typeof createAuth>;

async function lookupEmail(db: Db, userId: string | undefined): Promise<string | undefined> {
  if (!userId) return undefined;
  const [row] = await db
    .select({ email: authSchema.user.email })
    .from(authSchema.user)
    .where(eq(authSchema.user.id, userId));
  return row?.email;
}
