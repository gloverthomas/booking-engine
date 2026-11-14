import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { nextCookies } from "better-auth/next-js";
import { eq } from "drizzle-orm";
import * as authSchema from "@/db/auth-schema";
import type { Db } from "@/server/db-types";
import { evaluateIdentity } from "./owners";

const SESSION_DAYS = 30;
const SESSION_REFRESH_AFTER_HOURS = 24;

export interface AuthConfig {
  /** Any Drizzle Postgres database that has the auth tables (node-postgres in prod, PGlite in tests). */
  db: Db;
  secret: string;
  /** Public origin of the app, e.g. https://admin.example.com. Also the only trusted origin. */
  baseURL: string;
  google: { clientId: string; clientSecret: string };
  /** Read on every sign-in and session creation, so allow-list changes apply immediately. */
  ownerEmails: () => ReadonlySet<string>;
  secureCookies: boolean;
}

/**
 * Better Auth with Google as the only way in, gated by the owner allow-list.
 *
 * Defence in depth, because letting a stranger into the admin is the one thing that must not happen:
 *  1. `user.validateUserInfo` rejects non-owner identities before any account is created or linked.
 *  2. `databaseHooks.user.create.before` refuses to insert a user row for a non-owner.
 *  3. `databaseHooks.session.create.before` refuses to mint a session for a user who is no longer an owner.
 *  4. `requireOwner()` re-checks the allow-list on every request (see guard.ts).
 */
export function createAuth(config: AuthConfig) {
  const admits = (email: string | null | undefined, emailVerified?: boolean | null) =>
    evaluateIdentity({ email, emailVerified }, config.ownerEmails()) === null;

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
      validateUserInfo: ({ user }) => {
        const rejection = evaluateIdentity(
          { email: user.email, emailVerified: user.emailVerified },
          config.ownerEmails(),
        );
        return rejection ?? undefined;
      },
    },
    databaseHooks: {
      user: {
        create: {
          before: async (user) => {
            if (!admits(user.email, user.emailVerified)) return false;
          },
        },
      },
      session: {
        create: {
          before: async (session) => {
            const email = await lookupEmail(config.db, session.userId);
            if (!admits(email)) return false;
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
    plugins: [nextCookies()],
  });
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
