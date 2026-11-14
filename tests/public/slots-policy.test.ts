import { describe, expect, it } from "vitest";
import { groupSlotsByLocalDay, todayIn } from "@/lib/public-api-slots";
import { cancelResultMessage, describeCancellation } from "@/lib/public-api-policy";

const ZONE = "Australia/Melbourne";
const slot = (iso: string) => {
  const start = new Date(iso);
  return { start, end: new Date(start.getTime() + 15 * 60_000) };
};

describe("groupSlotsByLocalDay", () => {
  it("groups by local day, splits morning and afternoon, sorts and labels", () => {
    // AEDT (UTC+11): 23:00Z = 10:00 am next local day; 03:30Z = 2:30 pm
    const days = groupSlotsByLocalDay(
      [
        slot("2026-11-20T03:30:00Z"),
        slot("2026-11-19T23:00:00Z"),
        slot("2026-11-21T00:45:00Z"),
        slot("2026-11-20T01:00:00Z"),
      ],
      ZONE,
    );
    expect(days.map((d) => d.date)).toEqual(["2026-11-20", "2026-11-21"]);
    expect(days[0].morning.map((s) => s.label)).toEqual(["10:00 am"]);
    expect(days[0].afternoon.map((s) => s.label)).toEqual(["12:00 pm", "2:30 pm"]);
    expect(days[1].morning.map((s) => s.label)).toEqual(["11:45 am"]);
    expect(days[1].afternoon).toEqual([]);
  });

  it("keeps the 11:45 and 12:00 boundary on the right side", () => {
    const [day] = groupSlotsByLocalDay(
      [slot("2026-11-20T00:45:00Z"), slot("2026-11-20T01:00:00Z")],
      ZONE,
    );
    expect(day.morning).toHaveLength(1);
    expect(day.afternoon).toHaveLength(1);
  });

  it("collapses duplicate start times from several stylists", () => {
    const days = groupSlotsByLocalDay(
      [slot("2026-11-20T03:30:00Z"), slot("2026-11-20T03:30:00Z")],
      ZONE,
    );
    expect(days[0].afternoon).toHaveLength(1);
  });

  it("returns nothing for no slots", () => {
    expect(groupSlotsByLocalDay([], ZONE)).toEqual([]);
  });

  it("labels correctly on the day DST starts (2026-10-04, 2:00 am becomes 3:00 am)", () => {
    // 2026-10-03T15:30Z = 1:30 am AEST; 16:00Z = 3:00 am AEDT. 10:00 am AEDT = 2026-10-03T23:00Z
    const days = groupSlotsByLocalDay(
      [slot("2026-10-03T23:00:00Z"), slot("2026-10-04T03:00:00Z")],
      ZONE,
    );
    expect(days).toHaveLength(1);
    expect(days[0].date).toBe("2026-10-04");
    expect(days[0].morning[0].label).toBe("10:00 am");
    expect(days[0].afternoon[0].label).toBe("2:00 pm");
  });

  it("labels correctly on the day DST ends (2027-04-04)", () => {
    // After the change AEST (UTC+10): 10:00 am = 00:00Z
    const days = groupSlotsByLocalDay([slot("2027-04-04T00:00:00Z")], ZONE);
    expect(days[0].date).toBe("2027-04-04");
    expect(days[0].morning[0].label).toBe("10:00 am");
  });
});

describe("todayIn", () => {
  it("uses the business zone", () => {
    expect(todayIn(ZONE, new Date("2026-11-19T23:30:00Z"))).toBe("2026-11-20");
    expect(todayIn(ZONE, new Date("2026-11-19T12:00:00Z"))).toBe("2026-11-19");
  });
});

describe("describeCancellation", () => {
  const settings = { cancelWindowHours: 24, refundOutsideWindow: "refund" as const };
  const start = new Date("2026-11-20T03:30:00Z");
  const base = { status: "confirmed", start, depositCents: 4750, settings };

  it("refunds outside the window and allows rescheduling", () => {
    const info = describeCancellation({ ...base, now: new Date("2026-11-18T03:30:00Z") });
    expect(info).toMatchObject({
      canCancel: true,
      canReschedule: true,
      withinWindow: false,
      depositOutcome: "refund",
      blockedReason: null,
    });
    expect(info.cancelMessage).toContain("$47.50 deposit will be refunded");
    expect(info.deadline).toBe("2026-11-19T03:30:00.000Z");
  });

  it("offers credit when the business keeps deposits as credit", () => {
    const info = describeCancellation({
      ...base,
      now: new Date("2026-11-18T03:30:00Z"),
      settings: { ...settings, refundOutsideWindow: "credit" },
    });
    expect(info.depositOutcome).toBe("credit");
    expect(info.cancelMessage).toContain("credit");
  });

  it("forfeits the deposit inside the window and blocks rescheduling", () => {
    const info = describeCancellation({ ...base, now: new Date("2026-11-19T10:00:00Z") });
    expect(info).toMatchObject({
      canCancel: true,
      canReschedule: false,
      withinWindow: true,
      depositOutcome: "keep",
    });
    expect(info.cancelMessage).toContain("will not be refunded");
    expect(info.blockedReason).toContain("24 hours");
  });

  it("treats exactly the deadline as inside the window", () => {
    const info = describeCancellation({ ...base, now: new Date("2026-11-19T03:30:00Z") });
    expect(info.withinWindow).toBe(true);
  });

  it("handles a zero deposit", () => {
    const outside = describeCancellation({
      ...base,
      depositCents: 0,
      now: new Date("2026-11-18T03:30:00Z"),
    });
    expect(outside.depositOutcome).toBe("none");
    const inside = describeCancellation({
      ...base,
      depositCents: 0,
      now: new Date("2026-11-19T10:00:00Z"),
    });
    expect(inside.depositOutcome).toBe("none");
  });

  it("lets an unpaid booking be released but not moved", () => {
    const info = describeCancellation({
      ...base,
      status: "pending_payment",
      now: new Date("2026-11-18T03:30:00Z"),
    });
    expect(info).toMatchObject({ canCancel: true, canReschedule: false, depositOutcome: "none" });
  });

  it("blocks changes once the appointment has started", () => {
    const info = describeCancellation({ ...base, now: new Date("2026-11-20T04:00:00Z") });
    expect(info.canCancel).toBe(false);
    expect(info.blockedReason).toContain("already started");
  });

  it.each([
    ["cancelled_by_client", "cancelled"],
    ["late_cancelled", "cancelled"],
    ["completed", "complete"],
    ["no_show", "missed"],
    ["expired", "expired"],
    ["weird", "can't be changed"],
  ])("closes %s bookings", (status, text) => {
    const info = describeCancellation({
      ...base,
      status,
      now: new Date("2026-11-18T03:30:00Z"),
    });
    expect(info.canCancel).toBe(false);
    expect(info.canReschedule).toBe(false);
    expect(info.blockedReason).toContain(text);
  });
});

describe("cancelResultMessage", () => {
  it("covers each outcome", () => {
    expect(cancelResultMessage("refund", "refund", 4750, 24)).toContain("on its way back");
    expect(cancelResultMessage("keep", "keep", 4750, 24)).toContain("isn't refunded");
    expect(cancelResultMessage("none", "credit", 4750, 24)).toContain("credit");
    expect(cancelResultMessage("none", "none", 0, 24)).toBe("Your booking is cancelled.");
  });
});
