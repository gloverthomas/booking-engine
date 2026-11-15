import type { StaffRole } from "@/server/contracts";
import { can, type Permission } from "@/server/auth/permissions";

/** The slice of the signed-in session the Google routes need (`requireAccess` returns it). */
export interface GoogleAccessSession {
  staffId: string | null;
  role: StaffRole;
}

/** The permission a caller must hold just to reach the route for this target. */
export function permissionToReach(targetStaffId: string | null): Permission {
  return targetStaffId ? "calendar.viewOwn" : "integrations.manage";
}

/**
 * Who may connect or disconnect which calendar. The business-wide calendar needs
 * `integrations.manage` (the owner). A stylist's calendar can be managed by anyone with
 * `staff.manage` (owner, manager) and by that stylist themselves, never by another stylist.
 */
export function mayManageCalendar(
  session: GoogleAccessSession,
  targetStaffId: string | null,
): boolean {
  if (targetStaffId === null) return can(session.role, "integrations.manage");
  if (can(session.role, "staff.manage")) return true;
  return session.staffId === targetStaffId && can(session.role, "calendar.viewOwn");
}
