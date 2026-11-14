import { describe, expect, test } from "vitest";
import {
  decideCancellation,
  hoursUntil,
  isInsideCancelWindow,
  lateFee,
} from "@/server/booking/policy";
import { depositFor, percentOfCents } from "@/server/pricing";

const START = new Date("2026-11-10T01:00:00Z");
const hoursBefore = (h: number) => new Date(START.getTime() - h * 3_600_000);

const settings = { cancelWindowHours: 24, extraFeePct: 0, refundOutsideWindow: "refund" as const };

describe("deposit maths", () => {
  test("percentOfCents rounds to the nearest cent", () => {
    expect(percentOfCents(9500, 50)).toBe(4750);
    expect(percentOfCents(9999, 50)).toBe(5000); // 4999.5 -> 5000
    expect(percentOfCents(0, 50)).toBe(0);
  });

  test("depositFor sums each line using its override or the default percentage", () => {
    expect(depositFor([{ priceCents: 9500, depositPct: null }], 50)).toBe(4750);
    expect(
      depositFor(
        [
          { priceCents: 9500, depositPct: null }, // 50% of 9500 = 4750
          { priceCents: 20000, depositPct: 25 }, // 25% of 20000 = 5000
        ],
        50,
      ),
    ).toBe(9750);
  });

  test("a 0% override means no deposit for that line, and 100% means the full price", () => {
    expect(
      depositFor(
        [
          { priceCents: 9500, depositPct: 0 },
          { priceCents: 1000, depositPct: 100 },
        ],
        50,
      ),
    ).toBe(1000);
  });

  test("rounds once over the total, not per line", () => {
    // each line is 1.0002 / 0.9999 / 0.9999 cents; summed (3.0) and rounded once gives 3
    expect(
      depositFor(
        [
          { priceCents: 3, depositPct: 33.34 },
          { priceCents: 3, depositPct: 33.33 },
          { priceCents: 3, depositPct: 33.33 },
        ],
        50,
      ),
    ).toBe(3);
  });
});

describe("cancellation window", () => {
  test("hoursUntil is fractional and negative after the start", () => {
    expect(hoursUntil(START, hoursBefore(36))).toBeCloseTo(36);
    expect(hoursUntil(START, new Date(START.getTime() + 3_600_000))).toBeCloseTo(-1);
  });

  test("exactly on the boundary is outside the window (free to cancel)", () => {
    expect(isInsideCancelWindow(START, hoursBefore(24), 24)).toBe(false);
  });

  test("a minute inside the boundary is inside the window", () => {
    expect(isInsideCancelWindow(START, new Date(hoursBefore(24).getTime() + 60_000), 24)).toBe(
      true,
    );
  });

  test("after the start it is inside the window", () => {
    expect(isInsideCancelWindow(START, new Date(START.getTime() + 1), 24)).toBe(true);
  });

  test("a zero-hour window is only inside once the start has passed", () => {
    expect(isInsideCancelWindow(START, hoursBefore(0.01), 0)).toBe(false);
    expect(isInsideCancelWindow(START, new Date(START.getTime() + 1), 0)).toBe(true);
  });
});

describe("lateFee", () => {
  test("is a percentage of the total, rounded", () => {
    expect(lateFee(9500, 0)).toBe(0);
    expect(lateFee(9500, 50)).toBe(4750);
    expect(lateFee(9999, 33)).toBe(3300);
  });
});

describe("decideCancellation", () => {
  const base = { start: START, totalCents: 10000, settings, bookingStatus: "confirmed" as const };

  test("client outside the window: cancelled_by_client, deposit refunded, no fee", () => {
    expect(decideCancellation({ ...base, by: "client", now: hoursBefore(48) })).toEqual({
      status: "cancelled_by_client",
      depositAction: "refund",
      feeCents: 0,
    });
  });

  test("client outside the window with refundOutsideWindow=credit: deposit is kept as credit (action none)", () => {
    expect(
      decideCancellation({
        ...base,
        by: "client",
        now: hoursBefore(48),
        settings: { ...settings, refundOutsideWindow: "credit" },
      }),
    ).toEqual({ status: "cancelled_by_client", depositAction: "none", feeCents: 0 });
  });

  test("client inside the window: late_cancelled, deposit kept, fee from extraFeePct", () => {
    expect(
      decideCancellation({
        ...base,
        by: "client",
        now: hoursBefore(5),
        settings: { ...settings, extraFeePct: 25 },
      }),
    ).toEqual({ status: "late_cancelled", depositAction: "keep", feeCents: 2500 });
  });

  test("client inside the window with no extra fee configured: keep deposit, fee 0", () => {
    expect(decideCancellation({ ...base, by: "client", now: hoursBefore(5) })).toEqual({
      status: "late_cancelled",
      depositAction: "keep",
      feeCents: 0,
    });
  });

  test("staff always cancel with a refund and no fee, even inside the window", () => {
    expect(
      decideCancellation({
        ...base,
        by: "staff",
        now: hoursBefore(1),
        settings: { ...settings, extraFeePct: 50 },
      }),
    ).toEqual({ status: "cancelled_by_staff", depositAction: "refund", feeCents: 0 });
  });

  test("staff keepDeposit forfeits the deposit with no extra fee; forceRefund still wins", () => {
    expect(
      decideCancellation({
        ...base,
        by: "staff",
        now: hoursBefore(48),
        keepDeposit: true,
        settings: { ...settings, extraFeePct: 50 },
      }),
    ).toEqual({ status: "cancelled_by_staff", depositAction: "keep", feeCents: 0 });
    expect(
      decideCancellation({
        ...base,
        by: "staff",
        now: hoursBefore(48),
        keepDeposit: true,
        forceRefund: true,
      }),
    ).toEqual({ status: "cancelled_by_staff", depositAction: "refund", feeCents: 0 });
  });

  test("forceRefund overrides a late cancellation: refund, no fee, not late_cancelled", () => {
    expect(
      decideCancellation({
        ...base,
        by: "client",
        now: hoursBefore(1),
        forceRefund: true,
        settings: { ...settings, extraFeePct: 50 },
      }),
    ).toEqual({ status: "cancelled_by_client", depositAction: "refund", feeCents: 0 });
  });

  test("a pending_payment booking is cancelled with no deposit action and no fee", () => {
    for (const by of ["client", "staff"] as const) {
      expect(
        decideCancellation({
          ...base,
          bookingStatus: "pending_payment",
          by,
          now: hoursBefore(1),
          settings: { ...settings, extraFeePct: 50 },
        }),
      ).toEqual({
        status: by === "client" ? "cancelled_by_client" : "cancelled_by_staff",
        depositAction: "none",
        feeCents: 0,
      });
    }
  });
});
