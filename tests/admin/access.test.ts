import { describe, expect, test } from "vitest";
import {
  actorFor,
  assertCan,
  canAccessStaffMember,
  canMergeClients,
  canViewCalendar,
  effectiveStaffIds,
  staffScope,
  viewerCaps,
  type AccessContext,
} from "@/server/admin/access";
import type { StaffRole } from "@/server/contracts";

const stylist: AccessContext = { role: "stylist", staffId: "s1" };

describe("actorFor", () => {
  test("owner:<id> for owners, staff:<id> for the rest", () => {
    expect(actorFor("u1", "owner")).toBe("owner:u1");
    for (const role of ["manager", "stylist", "reception"] as const) {
      expect(actorFor("u2", role)).toBe("staff:u2");
    }
  });
});

describe("staffScope", () => {
  test("stylists are scoped to themselves, everyone else sees all", () => {
    expect(staffScope(stylist)).toEqual({ kind: "own", staffId: "s1" });
    for (const role of ["owner", "manager", "reception"] as const) {
      expect(staffScope({ role, staffId: null })).toEqual({ kind: "all" });
    }
  });

  test("a stylist without a staff row fails closed", () => {
    expect(() => staffScope({ role: "stylist", staffId: null })).toThrow(/staff profile/i);
  });
});

describe("canAccessStaffMember", () => {
  test("a stylist reaches only themselves", () => {
    expect(canAccessStaffMember(stylist, "s1")).toBe(true);
    expect(canAccessStaffMember(stylist, "s2")).toBe(false);
    expect(canAccessStaffMember({ role: "reception", staffId: null }, "s2")).toBe(true);
  });
});

describe("effectiveStaffIds", () => {
  test("unrestricted roles pass the request through, or null for no filter", () => {
    const owner: AccessContext = { role: "owner", staffId: null };
    expect(effectiveStaffIds(owner)).toBeNull();
    expect(effectiveStaffIds(owner, [])).toBeNull();
    expect(effectiveStaffIds(owner, ["a", "b"])).toEqual(["a", "b"]);
  });

  test("a stylist is pinned to themselves; asking only for others yields nothing", () => {
    expect(effectiveStaffIds(stylist)).toEqual(["s1"]);
    expect(effectiveStaffIds(stylist, ["s1", "s2"])).toEqual(["s1"]);
    expect(effectiveStaffIds(stylist, ["s2"])).toEqual([]);
  });
});

describe("permission matrix", () => {
  test("assertCan throws a plain message for a missing permission", () => {
    expect(() => assertCan(stylist, "money.refund")).toThrow(/permission/i);
    expect(() => assertCan(stylist, "checkout")).not.toThrow();
  });

  test("every role that has a calendar permission can open it", () => {
    for (const role of ["owner", "manager", "stylist", "reception"] as StaffRole[]) {
      expect(canViewCalendar(role)).toBe(true);
    }
  });

  test("merge is manager and owner only", () => {
    expect(canMergeClients("owner")).toBe(true);
    expect(canMergeClients("manager")).toBe(true);
    expect(canMergeClients("stylist")).toBe(false);
    expect(canMergeClients("reception")).toBe(false);
  });

  test("viewerCaps per role", () => {
    const caps = (role: StaffRole) => viewerCaps({ role, staffId: null });
    expect(caps("owner")).toMatchObject({ seesAll: true, refund: true, reassign: true });
    expect(caps("manager")).toMatchObject({ seesAll: true, refund: false, mergeClients: true });
    expect(caps("reception")).toMatchObject({
      seesAll: true,
      refund: false,
      reassign: true,
      mergeClients: false,
      checkout: true,
    });
    expect(caps("stylist")).toMatchObject({
      seesAll: false,
      refund: false,
      reassign: false,
      mergeClients: false,
      editBookings: true,
      editClients: true,
    });
  });
});
