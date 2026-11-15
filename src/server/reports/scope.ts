import type { StaffRole } from "../contracts";
import { can } from "../auth/permissions";

/**
 * Whose numbers a signed-in person may see in reports. Derived from the session on the server, never from the
 * URL: reports.viewAll sees everyone; reports.viewOwn alone is forced to their own staff id.
 */
export type ReportScope = { kind: "all" } | { kind: "own"; staffId: string } | { kind: "none" };

/** Thrown when the signed-in person may not see what was asked for. Callers turn it into a 403. */
export class ReportAccessError extends Error {
  constructor(message = "You can only see your own numbers.") {
    super(message);
    this.name = "ReportAccessError";
  }
}

export function reportScopeFor(role: StaffRole, staffId: string | null): ReportScope {
  if (can(role, "reports.viewAll")) return { kind: "all" };
  if (can(role, "reports.viewOwn") && staffId) return { kind: "own", staffId };
  return { kind: "none" };
}

/**
 * The staff id every query must be limited to. For an own-only scope the signed-in person's id always wins,
 * whatever was requested; for everyone else the requested id (if any) is just a filter.
 */
export function scopedStaffId(scope: ReportScope, requested?: string): string | undefined {
  if (scope.kind === "none")
    throw new ReportAccessError("No staff profile is linked to your login.");
  if (scope.kind === "own") return scope.staffId;
  return requested;
}

/** Business-wide tables (all clients, all balances) are for roles that see everyone. */
export function requireAllScope(scope: ReportScope): void {
  if (scope.kind !== "all")
    throw new ReportAccessError("That report is for managers and the owner.");
}
