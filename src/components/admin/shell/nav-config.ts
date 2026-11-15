import type { StaffRole } from "@/server/contracts";
import { hasPermission } from "@/server/auth/access-core";
import type { Permission } from "@/server/auth/permissions";

export type NavIcon =
  | "calendar"
  | "bookings"
  | "clients"
  | "waitlist"
  | "roster"
  | "timesheets"
  | "team"
  | "reports"
  | "catalog"
  | "staff"
  | "integrations"
  | "settings";

export interface NavItem {
  href: string;
  label: string;
  icon: NavIcon;
  /** The item shows only for roles that have this permission. */
  permission: Permission;
}

/** Where signing in lands. */
export const ADMIN_HOME = "/calendar";

/**
 * Every destination, in order. Pages other lanes build simply 404 until merged.
 * `navFor(role)` filters this by permission; the first four visible items are the phone tab bar.
 */
export const NAV_ITEMS: readonly NavItem[] = [
  { href: "/calendar", label: "Calendar", icon: "calendar", permission: "calendar.viewOwn" },
  { href: "/bookings", label: "Bookings", icon: "bookings", permission: "calendar.viewOwn" },
  { href: "/clients", label: "Clients", icon: "clients", permission: "clients.view" },
  { href: "/waitlist", label: "Waitlist", icon: "waitlist", permission: "waitlist.manage" },
  { href: "/roster", label: "Roster", icon: "roster", permission: "roster.viewOwn" },
  {
    href: "/timesheets",
    label: "Timesheets",
    icon: "timesheets",
    permission: "timesheets.viewOwn",
  },
  { href: "/team", label: "Team", icon: "team", permission: "reports.viewOwn" },
  { href: "/reports", label: "Reports", icon: "reports", permission: "reports.viewOwn" },
  { href: "/catalog", label: "Catalog", icon: "catalog", permission: "catalog.edit" },
  { href: "/staff", label: "Staff", icon: "staff", permission: "staff.manage" },
  {
    href: "/integrations",
    label: "Integrations",
    icon: "integrations",
    permission: "integrations.manage",
  },
  { href: "/settings", label: "Settings", icon: "settings", permission: "settings.edit" },
];

export const PRIMARY_NAV_COUNT = 4;

/** The items this role may see. */
export function navFor(role: StaffRole): readonly NavItem[] {
  return NAV_ITEMS.filter((item) => hasPermission(role, item.permission));
}

/** First four items are the phone tab bar; the rest live under "More". */
export function splitNav(items: readonly NavItem[]): {
  primary: readonly NavItem[];
  more: readonly NavItem[];
} {
  return { primary: items.slice(0, PRIMARY_NAV_COUNT), more: items.slice(PRIMARY_NAV_COUNT) };
}

/** A nav item is active on its own path and any sub-path (/catalog/services/new is under Catalog). */
export function isActivePath(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}
