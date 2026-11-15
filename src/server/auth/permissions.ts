import type { StaffRole } from "../contracts";

/** Everything a signed-in person may be allowed to do. Add here, then grant in ROLE_PERMISSIONS. */
export const PERMISSIONS = [
  "calendar.viewAll",
  "calendar.viewOwn",
  "booking.create",
  "booking.edit",
  "booking.cancel",
  "checkout",
  "clients.view",
  "clients.edit",
  "catalog.edit",
  "roster.viewAll",
  "roster.viewOwn",
  "roster.editAll",
  "timesheets.clock",
  "timesheets.viewOwn",
  "timesheets.viewAll",
  "timesheets.approve",
  "reports.viewAll",
  "reports.viewOwn",
  "waitlist.manage",
  "staff.manage",
  "settings.edit",
  "integrations.manage",
  "money.refund",
  "data.import",
] as const;

export type Permission = (typeof PERMISSIONS)[number];

const STYLIST: readonly Permission[] = [
  "calendar.viewOwn",
  "booking.create",
  "booking.edit",
  "booking.cancel",
  "checkout",
  "clients.view",
  "clients.edit",
  "roster.viewOwn",
  "timesheets.clock",
  "timesheets.viewOwn",
  "reports.viewOwn",
];

const RECEPTION: readonly Permission[] = [
  "calendar.viewAll",
  "booking.create",
  "booking.edit",
  "booking.cancel",
  "checkout",
  "clients.view",
  "clients.edit",
  "roster.viewAll",
  "timesheets.clock",
  "timesheets.viewOwn",
  "waitlist.manage",
];

const MANAGER: readonly Permission[] = [
  "calendar.viewAll",
  "calendar.viewOwn",
  "booking.create",
  "booking.edit",
  "booking.cancel",
  "checkout",
  "clients.view",
  "clients.edit",
  "catalog.edit",
  "roster.viewAll",
  "roster.viewOwn",
  "roster.editAll",
  "timesheets.clock",
  "timesheets.viewOwn",
  "timesheets.viewAll",
  "timesheets.approve",
  "reports.viewAll",
  "reports.viewOwn",
  "waitlist.manage",
  "staff.manage",
];

/** The owner can do everything, including settings, integrations and money. */
export const ROLE_PERMISSIONS: Record<StaffRole, ReadonlySet<Permission>> = {
  owner: new Set(PERMISSIONS),
  manager: new Set(MANAGER),
  stylist: new Set(STYLIST),
  reception: new Set(RECEPTION),
};

export function can(role: StaffRole, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].has(permission);
}

/** Roles that see every stylist's calendar rather than only their own. */
export function seesAllStaff(role: StaffRole): boolean {
  return can(role, "calendar.viewAll");
}
