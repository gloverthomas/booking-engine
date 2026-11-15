import { eq, type AnyColumn, type SQL } from "drizzle-orm";
import type { Actor } from "../audit";
import { can, seesAllStaff, type Permission } from "../auth/permissions";
import type { StaffRole } from "../contracts";
import { AdminError } from "./errors";
import type { ViewerCaps } from "./types";

/**
 * Who is acting, as far as the admin queries and commands care. Built from the signed-in session
 * (`requireAccess`) by `session.ts`; tests pass plain objects.
 */
export interface AccessContext {
  role: StaffRole;
  /** The signed-in person's staff row. Null only for an owner who has no staff row yet. */
  staffId: string | null;
}

/** Which stylists' data a person may see. Everyone but stylists sees all of it. */
export type StaffScope = { kind: "all" } | { kind: "own"; staffId: string };

export const NOT_ALLOWED_MESSAGE = "You do not have permission to do that.";
export const BOOKING_NOT_FOUND_MESSAGE = "That booking was not found";

/** `owner:<userId>` for the owner, `staff:<userId>` for everyone else signed in. */
export function actorFor(userId: string, role: StaffRole): Actor {
  return role === "owner" ? `owner:${userId}` : `staff:${userId}`;
}

export function staffScope(access: AccessContext): StaffScope {
  if (seesAllStaff(access.role)) return { kind: "all" };
  if (!access.staffId) {
    throw new AdminError(
      "Your login is not linked to a staff profile yet. Ask the owner to set it up.",
    );
  }
  return { kind: "own", staffId: access.staffId };
}

export function canAccessStaffMember(access: AccessContext, staffId: string): boolean {
  const scope = staffScope(access);
  return scope.kind === "all" || scope.staffId === staffId;
}

/** SQL predicate limiting a booking/block `staff_id` column to what the person may see. */
export function scopeCondition(column: AnyColumn, access: AccessContext): SQL | undefined {
  const scope = staffScope(access);
  return scope.kind === "all" ? undefined : eq(column, scope.staffId);
}

/**
 * Narrow an optional requested stylist filter to what the person may see.
 * `null` means unrestricted; an empty array means nothing is visible (a stylist asking for a colleague).
 */
export function effectiveStaffIds(
  access: AccessContext,
  requested?: readonly string[],
): string[] | null {
  const scope = staffScope(access);
  const wanted = requested && requested.length > 0 ? requested : undefined;
  if (scope.kind === "own") {
    return !wanted || wanted.includes(scope.staffId) ? [scope.staffId] : [];
  }
  return wanted ? [...wanted] : null;
}

export function assertCan(access: AccessContext, permission: Permission): void {
  if (!can(access.role, permission)) throw new AdminError(NOT_ALLOWED_MESSAGE);
}

/** True when the role may open the calendar at all (own column or everyone's). */
export function canViewCalendar(role: StaffRole): boolean {
  return can(role, "calendar.viewAll") || can(role, "calendar.viewOwn");
}

export function assertCanViewCalendar(access: AccessContext): void {
  if (!canViewCalendar(access.role)) throw new AdminError(NOT_ALLOWED_MESSAGE);
}

/** Merging two client records rewrites history, so it is for managers and the owner only. */
export function canMergeClients(role: StaffRole): boolean {
  return (role === "owner" || role === "manager") && can(role, "clients.edit");
}

/** What the UI may offer. The server re-checks every one of these in the command. */
export function viewerCaps(access: AccessContext): ViewerCaps {
  const { role } = access;
  return {
    role,
    staffId: access.staffId,
    seesAll: seesAllStaff(role),
    createBookings: can(role, "booking.create"),
    editBookings: can(role, "booking.edit"),
    cancelBookings: can(role, "booking.cancel"),
    checkout: can(role, "checkout"),
    reassign: can(role, "booking.edit") && seesAllStaff(role),
    refund: can(role, "money.refund"),
    viewClients: can(role, "clients.view"),
    editClients: can(role, "clients.edit"),
    mergeClients: canMergeClients(role),
  };
}
