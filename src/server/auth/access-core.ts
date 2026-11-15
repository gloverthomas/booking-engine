import type { StaffRole } from "../contracts";
import type { Actor } from "../audit";
import { can, type Permission } from "./permissions";

/**
 * Pure access rules shared by the guard, the actions and the (client-side) navigation.
 * No I/O and no Next imports, so it is safe to import anywhere.
 */
export interface AccessSession {
  userId: string;
  email: string;
  /** The signed-in person's staff row. Null only for an owner who has no staff row yet. */
  staffId: string | null;
  role: StaffRole;
  /** The staff member's display name, when known. */
  name?: string;
}

/** Marker Next.js keeps on the error so the (admin) error boundary can show the friendly page. */
export const ACCESS_DENIED_DIGEST = "ACCESS_DENIED";

export class AccessDeniedError extends Error {
  /** Next.js preserves a pre-set digest, so error.tsx can recognise this error in production. */
  readonly digest = ACCESS_DENIED_DIGEST;

  constructor(readonly permission: Permission | "owner") {
    super(`Not allowed: ${permission}`);
    this.name = "AccessDeniedError";
  }
}

/**
 * `can()` plus one rule the role table leaves implicit: whoever may view everyone's X may also view
 * their own (reception has calendar.viewAll but not calendar.viewOwn).
 */
export function hasPermission(role: StaffRole, permission: Permission): boolean {
  if (can(role, permission)) return true;
  if (permission.endsWith(".viewOwn")) {
    return can(role, permission.replace(/\.viewOwn$/, ".viewAll") as Permission);
  }
  return false;
}

export function assertAccess(session: AccessSession, permission: Permission): AccessSession {
  if (!hasPermission(session.role, permission)) throw new AccessDeniedError(permission);
  return session;
}

/** The audit actor for a signed-in person: `owner:<id>` for owners, `staff:<id>` for everyone else. */
export function actorFor(session: Pick<AccessSession, "userId" | "role">): Actor {
  return session.role === "owner" ? `owner:${session.userId}` : `staff:${session.userId}`;
}
