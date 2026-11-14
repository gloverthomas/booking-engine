import { describe, expect, test } from "vitest";
import { PERMISSIONS, ROLE_PERMISSIONS, can, seesAllStaff } from "@/server/auth/permissions";

describe("role permissions", () => {
  test("the owner can do everything", () => {
    for (const p of PERMISSIONS) expect(can("owner", p)).toBe(true);
  });

  test("only the owner can change settings, integrations and money", () => {
    for (const role of ["manager", "stylist", "reception"] as const) {
      expect(can(role, "settings.edit")).toBe(false);
      expect(can(role, "integrations.manage")).toBe(false);
      expect(can(role, "money.refund")).toBe(false);
    }
  });

  test("a stylist works with their own calendar, clock and reports, and nothing wider", () => {
    expect(seesAllStaff("stylist")).toBe(false);
    expect(can("stylist", "calendar.viewOwn")).toBe(true);
    expect(can("stylist", "calendar.viewAll")).toBe(false);
    expect(can("stylist", "timesheets.clock")).toBe(true);
    expect(can("stylist", "timesheets.viewAll")).toBe(false);
    expect(can("stylist", "reports.viewAll")).toBe(false);
    expect(can("stylist", "staff.manage")).toBe(false);
    expect(can("stylist", "catalog.edit")).toBe(false);
  });

  test("reception runs the front desk but sees no reports or catalog edits", () => {
    expect(seesAllStaff("reception")).toBe(true);
    expect(can("reception", "booking.create")).toBe(true);
    expect(can("reception", "checkout")).toBe(true);
    expect(can("reception", "waitlist.manage")).toBe(true);
    expect(can("reception", "reports.viewOwn")).toBe(false);
    expect(can("reception", "catalog.edit")).toBe(false);
  });

  test("a manager runs the team: rosters, approvals, reports, staff", () => {
    for (const p of [
      "roster.editAll",
      "timesheets.approve",
      "reports.viewAll",
      "staff.manage",
    ] as const) {
      expect(can("manager", p)).toBe(true);
    }
  });

  test("every granted permission is a known permission", () => {
    const known = new Set<string>(PERMISSIONS);
    for (const set of Object.values(ROLE_PERMISSIONS)) {
      for (const p of set) expect(known.has(p)).toBe(true);
    }
  });
});
