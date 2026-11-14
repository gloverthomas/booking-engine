import { headers } from "next/headers";
import { redirect, unstable_rethrow } from "next/navigation";
import { getDb } from "@/db/client";
import { getEnv } from "@/lib/env";
import { createLogger } from "@/lib/logger";
import { createAuth, type Auth } from "./auth";
import { readAuthConfig } from "./config";
import { createOwnerGuard, type OwnerGuard, type OwnerSession } from "./guard";
import { parseOwnerEmails } from "./owners";

export type { OwnerSession } from "./guard";

const log = createLogger("auth");

let authInstance: Auth | undefined;

/** The Better Auth instance, created on first use so importing this module never needs env. */
export function getAuth(): Auth {
  authInstance ??= createAuth(readAuthConfig(getEnv(), getDb()));
  return authInstance;
}

let guard: OwnerGuard | undefined;

function getGuard(): OwnerGuard {
  guard ??= createOwnerGuard({
    getSession: async () => {
      // Read the request first: it makes the caller dynamic (never prerendered at build time, when
      // the auth environment may be absent) before any configuration is touched.
      const requestHeaders = await headers();
      return getAuth().api.getSession({ headers: requestHeaders });
    },
    ownerEmails: () => parseOwnerEmails(getEnv().OWNER_EMAILS),
    redirectToLogin: () => redirect("/login"),
    onError: (error) => {
      // Never swallow Next's own control-flow errors (dynamic-API bailouts during prerender, redirects).
      unstable_rethrow(error);
      log({ event: "session_lookup_failed", message: error instanceof Error ? error.message : "" });
    },
  });
  return guard;
}

/** Redirects to /login when there is no signed-in owner. Used by every admin route and action. */
export async function requireOwner(): Promise<OwnerSession> {
  return getGuard().requireOwner();
}

/** Returns the session or null, without throwing. */
export async function getOwnerSession(): Promise<OwnerSession | null> {
  return getGuard().getOwnerSession();
}
