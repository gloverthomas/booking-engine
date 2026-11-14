export type NavIcon =
  | "calendar"
  | "bookings"
  | "clients"
  | "catalog"
  | "hours"
  | "reports"
  | "integrations"
  | "settings";

export interface NavItem {
  href: string;
  label: string;
  icon: NavIcon;
}

/** Where signing in lands. Workstream E builds the calendar page. */
export const ADMIN_HOME = "/calendar";

/** The admin's navigation, in order. The first four are the phone tab bar; the rest live under "More". */
export const NAV_ITEMS: readonly NavItem[] = [
  { href: "/calendar", label: "Calendar", icon: "calendar" },
  { href: "/bookings", label: "Bookings", icon: "bookings" },
  { href: "/clients", label: "Clients", icon: "clients" },
  { href: "/catalog", label: "Catalog", icon: "catalog" },
  { href: "/hours", label: "Hours", icon: "hours" },
  { href: "/reports", label: "Reports", icon: "reports" },
  { href: "/integrations", label: "Integrations", icon: "integrations" },
  { href: "/settings", label: "Settings", icon: "settings" },
];

export const PRIMARY_NAV_COUNT = 4;

export const PRIMARY_NAV: readonly NavItem[] = NAV_ITEMS.slice(0, PRIMARY_NAV_COUNT);
export const MORE_NAV: readonly NavItem[] = NAV_ITEMS.slice(PRIMARY_NAV_COUNT);

/** A nav item is active on its own path and any sub-path (/catalog/services/new is under Catalog). */
export function isActivePath(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}
