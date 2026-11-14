import type { StaffRole } from "../contracts";
import { requireOwner } from "./index";
import { can, type Permission } from "./permissions";

/**
 * OWNER: workstream W1 (staff & access). Replace this stub with the real lookup (session -> staff row ->
 * role), keeping the signatures. Every admin route and action calls requireAccess(permission) instead of
 * requireOwner(), then scopes its queries with `session.staffId` when the role cannot see everyone.
 */
export interface AccessSession {
  userId: string;
  email: string;
  /** The signed-in person's staff row. Null only for an owner who has no staff row yet. */
  staffId: string | null;
  role: StaffRole;
}

/** Redirects to /login when signed out; throws AccessDeniedError when the role lacks the permission. */
export async function requireAccess(permission: Permission): Promise<AccessSession> {
  const owner = await requireOwner();
  const session: AccessSession = {
    userId: owner.userId,
    email: owner.email,
    staffId: null,
    role: "owner",
  };
  if (!can(session.role, permission)) throw new AccessDeniedError(permission);
  return session;
}

/** Same as requireAccess without a permission check. */
export async function requireStaffSession(): Promise<AccessSession> {
  const owner = await requireOwner();
  return { userId: owner.userId, email: owner.email, staffId: null, role: "owner" };
}

export class AccessDeniedError extends Error {
  constructor(readonly permission: Permission) {
    super(`Not allowed: ${permission}`);
    this.name = "AccessDeniedError";
  }
}
