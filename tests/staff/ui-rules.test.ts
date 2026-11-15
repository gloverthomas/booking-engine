import { describe, expect, test } from "vitest";
import { assignableRoles, canManageRow } from "@/components/admin/staff/rules";
import { connectHref, disconnectHref } from "@/components/admin/staff/GoogleCalendarControl";
import { toStaffRowViews } from "@/components/admin/staff/views";
import type { StaffListItem } from "@/server/staff/queries";

describe("staff UI rules mirror the server", () => {
  test("only owners can grant owner", () => {
    expect(assignableRoles("owner")).toContain("owner");
    expect(assignableRoles("manager")).toEqual(["manager", "stylist", "reception"]);
  });

  test("managers cannot manage owners; owners can manage anyone", () => {
    expect(canManageRow("manager", "owner")).toBe(false);
    expect(canManageRow("manager", "stylist")).toBe(true);
    expect(canManageRow("owner", "owner")).toBe(true);
  });
});

describe("Google Calendar links", () => {
  test("connect and disconnect carry the staff id", () => {
    expect(connectHref("abc")).toBe("/api/integrations/google/connect?staffId=abc");
    expect(disconnectHref("a b")).toBe("/api/integrations/google/disconnect?staffId=a%20b");
  });
});

describe("toStaffRowViews", () => {
  const base: StaffListItem = {
    id: "1",
    name: "Mia",
    email: "m@example.com",
    phone: null,
    role: "stylist",
    level: 0,
    colour: null,
    active: true,
    hasSignedIn: false,
    google: null,
  };

  test("formats the last sync in the business time zone and keeps nulls", () => {
    const [plain, linked] = toStaffRowViews(
      [
        base,
        {
          ...base,
          id: "2",
          google: {
            status: "connected",
            calendar: "m@example.com",
            lastSyncAt: new Date("2030-01-01T00:30:00Z"),
            lastError: null,
          },
        },
      ],
      "Australia/Melbourne",
    );
    expect(plain.google).toBeNull();
    expect(linked.google?.lastSyncText).toBe("Tue 1 Jan, 11:30 AM");
  });

  test("a link that never synced has no sync text", () => {
    const [view] = toStaffRowViews(
      [{ ...base, google: { status: "error", calendar: null, lastSyncAt: null, lastError: "x" } }],
      "Australia/Melbourne",
    );
    expect(view.google).toMatchObject({ lastSyncText: null, lastError: "x" });
  });
});
