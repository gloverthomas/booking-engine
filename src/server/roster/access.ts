import type { Actor } from "../audit";
import type { StaffRole } from "../contracts";
import { can } from "../auth/permissions";

export interface RosterAccess {
  /** "all" sees every stylist's roster; "own" sees only their own. */
  scope: "all" | "own";
  canEdit: boolean;
}

/** What a role may do on the roster page, or null when it may not see it at all. */
export function rosterAccessFor(role: StaffRole): RosterAccess | null {
  if (can(role, "roster.viewAll")) return { scope: "all", canEdit: can(role, "roster.editAll") };
  if (can(role, "roster.viewOwn")) return { scope: "own", canEdit: can(role, "roster.editAll") };
  return null;
}

/** `owner:<id>` for the owner, `staff:<id>` for any other signed-in team member. */
export function auditActorFor(session: { userId: string; role: StaffRole }): Actor {
  return session.role === "owner" ? `owner:${session.userId}` : `staff:${session.userId}`;
}
