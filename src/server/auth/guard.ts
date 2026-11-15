import type { AccessSession } from "./access-core";
import type { SignedInUser } from "./resolve-access";

/** What owner-only callers (the integration routes, `requireOwner`) get back. */
export interface OwnerSession {
  userId: string;
  email: string;
}

interface RawSession {
  user: SignedInUser;
}

export interface GuardDeps {
  /** Reads the current Better Auth session from the request cookies. */
  getSession: () => Promise<RawSession | null>;
  /**
   * Maps the signed-in Google user to a staff role, or null when they are not (or no longer) allowed.
   * Called on every request so removing or deactivating someone revokes access immediately.
   */
  resolveAccess: (user: SignedInUser) => Promise<AccessSession | null>;
  /** Must not return (Next's redirect() throws). `reason` is set when a session exists but is not allowed in. */
  redirectToLogin: (reason?: "not_authorised") => never;
  onError: (error: unknown) => void;
}

export interface AccessGuard {
  /** The signed-in, allowed-in person; redirects to /login otherwise. */
  requireSession: () => Promise<AccessSession>;
  /** Same, but returns null instead of redirecting and never throws (logs lookup failures). */
  getSession: () => Promise<AccessSession | null>;
}

/** Builds the guard from injected dependencies so the logic is testable without Next or a database. */
export function createAccessGuard(deps: GuardDeps): AccessGuard {
  /** `signedIn` distinguishes "no session" from "has a session but is not allowed in". */
  async function resolve(): Promise<{ access: AccessSession | null; signedIn: boolean }> {
    const raw = await deps.getSession();
    if (!raw) return { access: null, signedIn: false };
    return { access: await deps.resolveAccess(raw.user), signedIn: true };
  }

  return {
    async requireSession() {
      const { access, signedIn } = await resolve();
      if (access) return access;
      return deps.redirectToLogin(signedIn ? "not_authorised" : undefined);
    },
    async getSession() {
      try {
        return (await resolve()).access;
      } catch (error) {
        deps.onError(error);
        return null;
      }
    },
  };
}
