import { isOwnerEmail } from "./owners";

export interface OwnerSession {
  userId: string;
  email: string;
}

interface RawSession {
  user: { id: string; email: string };
}

export interface GuardDeps {
  /** Reads the current Better Auth session from the request cookies. */
  getSession: () => Promise<RawSession | null>;
  /** Re-read on every call, so removing an owner from OWNER_EMAILS revokes access immediately. */
  ownerEmails: () => ReadonlySet<string>;
  /** Must not return (Next's redirect() throws). */
  redirectToLogin: () => never;
  onError: (error: unknown) => void;
}

export interface OwnerGuard {
  requireOwner: () => Promise<OwnerSession>;
  getOwnerSession: () => Promise<OwnerSession | null>;
}

/** Builds the guard from injected dependencies so the logic is testable without Next or a database. */
export function createOwnerGuard(deps: GuardDeps): OwnerGuard {
  async function resolve(): Promise<OwnerSession | null> {
    const session = await deps.getSession();
    if (!session) return null;
    if (!isOwnerEmail(session.user.email, deps.ownerEmails())) return null;
    return { userId: session.user.id, email: session.user.email };
  }

  return {
    async requireOwner() {
      const owner = await resolve();
      if (!owner) return deps.redirectToLogin();
      return owner;
    },
    async getOwnerSession() {
      try {
        return await resolve();
      } catch (error) {
        deps.onError(error);
        return null;
      }
    },
  };
}
