/** OWNER: workstream D (admin foundation). Replace this stub; keep the signatures. */

export interface OwnerSession {
  userId: string;
  email: string;
}

/** Throws (or redirects to /login) when there is no signed-in owner. Used by every admin route and action. */
export async function requireOwner(): Promise<OwnerSession> {
  throw new Error("requireOwner not implemented");
}

/** Returns the session or null, without throwing. */
export async function getOwnerSession(): Promise<OwnerSession | null> {
  return null;
}
