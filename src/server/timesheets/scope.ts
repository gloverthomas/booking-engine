import type { StaffRole } from "../contracts";
import { can } from "../auth/permissions";

/** Whose timesheets a signed-in person may look at. */
export type TimesheetScope = { kind: "all" } | { kind: "own"; staffId: string } | { kind: "none" };

/**
 * Roles with timesheets.viewAll see the whole team; everyone else sees only their own row. Resolved from the
 * session on the server: a `staff` URL parameter can narrow the team view but never widen an own-only view.
 */
export function timesheetScopeFor(role: StaffRole, staffId: string | null): TimesheetScope {
  if (can(role, "timesheets.viewAll")) return { kind: "all" };
  return staffId ? { kind: "own", staffId } : { kind: "none" };
}

/** The staff ids to load: `"all"` for the whole team, or a list (empty when nothing may be shown). */
export function staffIdsFor(scope: TimesheetScope, requested?: string): readonly string[] | "all" {
  if (scope.kind === "none") return [];
  if (scope.kind === "own") return [scope.staffId]; // any requested id is ignored
  return requested ? [requested] : "all";
}
