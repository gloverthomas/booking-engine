import { headers } from "next/headers";
import { redirect, unstable_rethrow } from "next/navigation";
import { getDb } from "@/db/client";
import { getEnv } from "@/lib/env";
import { createLogger } from "@/lib/logger";
import { AccessDeniedError, type AccessSession } from "./access-core";
import { createAuth, type Auth } from "./auth";
import { readAuthConfig } from "./config";
import { createAccessGuard, type AccessGuard, type OwnerSession } from "./guard";
import { parseOwnerEmails } from "./owners";
import { resolveAccess } from "./resolve-access";

export type { OwnerSession } from "./guard";

const log = createLogger("auth");

let authInstance: Auth | undefined;

/** The Better Auth instance, created on first use so importing this module never needs env. */
export function getAuth(): Auth {
  authInstance ??= createAuth(readAuthConfig(getEnv(), getDb()));
  return authInstance;
}

let guard: AccessGuard | undefined;

function getGuard(): AccessGuard {
  guard ??= createAccessGuard({
    getSession: async () => {
      // Read the request first: it makes the caller dynamic (never prerendered at build time, when
      // the auth environment may be absent) before any configuration is touched.
      const requestHeaders = await headers();
      return getAuth().api.getSession({ headers: requestHeaders });
    },
    resolveAccess: (user) => resolveAccess(getDb(), user, parseOwnerEmails(getEnv().OWNER_EMAILS)),
    redirectToLogin: (reason) => redirect(reason ? `/login?error=${reason}` : "/login"),
    onError: (error) => {
      // Never swallow Next's own control-flow errors (dynamic-API bailouts during prerender, redirects).
      unstable_rethrow(error);
      log({ event: "session_lookup_failed", message: error instanceof Error ? error.message : "" });
    },
  });
  return guard;
}

/** Any allowed-in team member (owner, manager, stylist or reception); redirects to /login otherwise. */
export async function requireAccessSession(): Promise<AccessSession> {
  return getGuard().requireSession();
}

/** The team member's session or null, without throwing. */
export async function getAccessSession(): Promise<AccessSession | null> {
  return getGuard().getSession();
}

/**
 * Redirects to /login when nobody is signed in; throws AccessDeniedError for a signed-in team member
 * who is not an owner. Owner-only routes (money, integrations) use it.
 */
export async function requireOwner(): Promise<OwnerSession> {
  const session = await getGuard().requireSession();
  if (session.role !== "owner") throw new AccessDeniedError("owner");
  return { userId: session.userId, email: session.email };
}

/** The owner's session or null (null for a signed-in non-owner as well), without throwing. */
export async function getOwnerSession(): Promise<OwnerSession | null> {
  const session = await getGuard().getSession();
  return session?.role === "owner" ? { userId: session.userId, email: session.email } : null;
}
