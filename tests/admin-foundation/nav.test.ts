import { describe, expect, test } from "vitest";
import {
  ADMIN_HOME,
  isActivePath,
  NAV_ITEMS,
  navFor,
  splitNav,
} from "@/components/admin/shell/nav-config";
import { nextTabIndex } from "@/components/ui/tabs-logic";
import { PERMISSIONS } from "@/server/auth/permissions";

const labels = (role: Parameters<typeof navFor>[0]) => navFor(role).map((i) => i.label);

describe("admin navigation", () => {
  test("lists every destination in the agreed order, with Roster instead of Hours", () => {
    expect(NAV_ITEMS.map((i) => i.label)).toEqual([
      "Calendar",
      "Bookings",
      "Clients",
      "Waitlist",
      "Roster",
      "Timesheets",
      "Team",
      "Reports",
      "Catalog",
      "Staff",
      "Import",
      "Integrations",
      "Settings",
    ]);
    expect(NAV_ITEMS.find((i) => i.label === "Roster")?.href).toBe("/roster");
  });

  test("every item is guarded by a real permission", () => {
    for (const item of NAV_ITEMS) expect(PERMISSIONS).toContain(item.permission);
  });

  test("the owner sees everything", () => {
    expect(navFor("owner")).toEqual([...NAV_ITEMS]);
  });

  test("only the owner sees Import", () => {
    expect(labels("owner")).toContain("Import");
    for (const role of ["manager", "stylist", "reception"] as const) {
      expect(labels(role)).not.toContain("Import");
    }
  });

  test("a manager runs the team but has no Integrations or Settings", () => {
    expect(labels("manager")).toEqual([
      "Calendar",
      "Bookings",
      "Clients",
      "Waitlist",
      "Roster",
      "Timesheets",
      "Team",
      "Reports",
      "Catalog",
      "Staff",
    ]);
  });

  test("a stylist sees their own work only: no waitlist, catalog, staff or settings", () => {
    expect(labels("stylist")).toEqual([
      "Calendar",
      "Bookings",
      "Clients",
      "Roster",
      "Timesheets",
      "Team",
      "Reports",
    ]);
  });

  test("reception sees the front desk, including Calendar via calendar.viewAll, and no reports", () => {
    expect(labels("reception")).toEqual([
      "Calendar",
      "Bookings",
      "Clients",
      "Waitlist",
      "Roster",
      "Timesheets",
    ]);
  });

  test("splits into a four-tab phone bar plus 'More' without losing or repeating anything", () => {
    for (const role of ["owner", "manager", "stylist", "reception"] as const) {
      const items = navFor(role);
      const { primary, more } = splitNav(items);
      expect(primary).toHaveLength(4);
      expect([...primary, ...more]).toEqual([...items]);
    }
    expect(splitNav(navFor("owner")).more.map((i) => i.label)).toContain("Settings");
  });

  test("a short list has no overflow", () => {
    expect(splitNav(NAV_ITEMS.slice(0, 2))).toEqual({
      primary: NAV_ITEMS.slice(0, 2),
      more: [],
    });
  });

  test("lands on the calendar and every route is absolute and unique", () => {
    expect(ADMIN_HOME).toBe("/calendar");
    const hrefs = NAV_ITEMS.map((i) => i.href);
    expect(new Set(hrefs).size).toBe(hrefs.length);
    expect(hrefs.every((h) => h.startsWith("/"))).toBe(true);
  });

  test("active matching covers sub-paths but not look-alike prefixes", () => {
    expect(isActivePath("/catalog", "/catalog")).toBe(true);
    expect(isActivePath("/catalog/services/new", "/catalog")).toBe(true);
    expect(isActivePath("/catalogue", "/catalog")).toBe(false);
    expect(isActivePath("/hours", "/catalog")).toBe(false);
  });
});

describe("nextTabIndex (tabs keyboard navigation)", () => {
  test("arrows wrap around", () => {
    expect(nextTabIndex("ArrowRight", 0, 3)).toBe(1);
    expect(nextTabIndex("ArrowRight", 2, 3)).toBe(0);
    expect(nextTabIndex("ArrowLeft", 0, 3)).toBe(2);
    expect(nextTabIndex("ArrowLeft", 2, 3)).toBe(1);
  });

  test("Home and End jump to the ends", () => {
    expect(nextTabIndex("Home", 2, 4)).toBe(0);
    expect(nextTabIndex("End", 0, 4)).toBe(3);
  });

  test("other keys and empty lists do nothing", () => {
    expect(nextTabIndex("Enter", 0, 3)).toBeNull();
    expect(nextTabIndex("ArrowRight", 0, 0)).toBe(null);
  });
});
