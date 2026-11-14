import { describe, expect, test } from "vitest";
import {
  ADMIN_HOME,
  isActivePath,
  MORE_NAV,
  NAV_ITEMS,
  PRIMARY_NAV,
} from "@/components/admin/shell/nav-config";
import { nextTabIndex } from "@/components/ui/tabs-logic";

describe("admin navigation", () => {
  test("has the eight required destinations in order", () => {
    expect(NAV_ITEMS.map((i) => i.label)).toEqual([
      "Calendar",
      "Bookings",
      "Clients",
      "Catalog",
      "Hours",
      "Reports",
      "Integrations",
      "Settings",
    ]);
  });

  test("splits into a four-tab phone bar plus 'More' without losing or repeating anything", () => {
    expect(PRIMARY_NAV).toHaveLength(4);
    expect([...PRIMARY_NAV, ...MORE_NAV]).toEqual([...NAV_ITEMS]);
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
    expect(nextTabIndex("ArrowRight", 0, 0)).toBeNull();
  });
});
