import { headers } from "next/headers";
import { redirect } from "next/navigation";
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
    getSession: async () => getAuth().api.getSession({ headers: await headers() }),
    ownerEmails: () => parseOwnerEmails(getEnv().OWNER_EMAILS),
    redirectToLogin: () => redirect("/login"),
    onError: (error) => {
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
