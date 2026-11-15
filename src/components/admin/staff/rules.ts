import type { StaffRole } from "@/server/contracts";
import { STAFF_ROLES } from "@/server/staff/schemas";

/** Mirrors the server rule (commands.ts) so the UI never offers what the server would refuse. */
export function canManageRow(viewerRole: StaffRole, rowRole: StaffRole): boolean {
  return viewerRole === "owner" || rowRole !== "owner";
}

/** Roles the viewer may hand out: only an owner can grant owner. */
export function assignableRoles(viewerRole: StaffRole): readonly StaffRole[] {
  return viewerRole === "owner" ? STAFF_ROLES : STAFF_ROLES.filter((role) => role !== "owner");
}
