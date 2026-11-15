import { assertAccess, type AccessSession } from "./access-core";
import { requireAccessSession } from "./index";
import type { Permission } from "./permissions";

export { AccessDeniedError, type AccessSession } from "./access-core";

/**
 * Every admin route and action calls requireAccess(permission) instead of requireOwner(), then scopes
 * its queries with `session.staffId` when the role cannot see everyone (`!seesAllStaff(role)`).
 * Redirects to /login when signed out; throws AccessDeniedError when the role lacks the permission.
 */
export async function requireAccess(permission: Permission): Promise<AccessSession> {
  return assertAccess(await requireAccessSession(), permission);
}

/** Same as requireAccess without a permission check: any allowed-in team member. */
export async function requireStaffSession(): Promise<AccessSession> {
  return requireAccessSession();
}
