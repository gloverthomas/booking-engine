import { describe, expect, test } from "vitest";
import {
  describeActor,
  describeAuditAction,
  formatDateTime,
  formatMoney,
  formatTimeRange,
} from "@/components/admin/calendar/format";

const TZ = "Australia/Melbourne";

describe("format helpers", () => {
  test("formats AUD amounts", () => {
    expect(formatMoney(9500)).toBe("$95.00");
    expect(formatMoney(0)).toBe("$0.00");
  });

  test("formats instants in the business zone", () => {
    expect(formatDateTime("2026-11-14T00:00:00.000Z", TZ)).toBe("Sat 14 Nov, 11:00 am");
    expect(formatTimeRange("2026-11-14T00:00:00.000Z", "2026-11-14T00:45:00.000Z", TZ)).toBe(
      "11:00 am to 11:45 am",
    );
  });

  test("describes audit rows for humans", () => {
    expect(describeAuditAction("booking.rescheduled_by_staff")).toBe("Rescheduled by staff");
    expect(describeAuditAction("plain")).toBe("Plain");
    expect(describeActor("owner:abc")).toBe("You");
    expect(describeActor("client")).toBe("Client");
    expect(describeActor("mcp")).toBe("Claude");
    expect(describeActor("system")).toBe("System");
  });
});
