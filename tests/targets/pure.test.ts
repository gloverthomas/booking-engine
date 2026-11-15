import { describe, expect, test } from "vitest";
import {
  elapsedPct,
  periodEnded,
  periodRange,
  pickTarget,
  progressOf,
  shiftAnchor,
  type TargetLike,
} from "@/server/targets/progress";
import {
  formatPercentBps,
  formatTargetValue,
  parseTargetInput,
  targetInputValue,
} from "@/server/targets/units";
import { TargetError } from "@/server/targets/errors";
import { performanceQuerySchema, targetFormSchema } from "@/server/targets/schemas";

const TZ = "Australia/Melbourne";
// Sat 14 Nov 2026, 12:00 local.
const NOW = new Date("2026-11-14T01:00:00Z");

describe("units", () => {
  test("revenue is parsed to exact cents", () => {
    expect(parseTargetInput("revenue", "4000")).toBe(400_000);
    expect(parseTargetInput("revenue", "$4,000.50")).toBe(400_050);
    expect(parseTargetInput("revenue", "4000.1")).toBe(400_010);
    expect(parseTargetInput("revenue", " 0.01 ")).toBe(1);
  });

  test("bookings are whole counts", () => {
    expect(parseTargetInput("bookings", "30")).toBe(30);
    expect(() => parseTargetInput("bookings", "30.5")).toThrow(TargetError);
    expect(() => parseTargetInput("bookings", "-3")).toThrow(TargetError);
  });

  test("rates are basis points and capped at 100%", () => {
    expect(parseTargetInput("utilisation", "75")).toBe(7500);
    expect(parseTargetInput("rebook_rate", "62.5%")).toBe(6250);
    expect(parseTargetInput("rebook_rate", "100")).toBe(10_000);
    expect(() => parseTargetInput("rebook_rate", "100.5")).toThrow(TargetError);
    expect(() => parseTargetInput("utilisation", "abc")).toThrow(TargetError);
  });

  test("rejects zero, negative, junk and absurd values with a field error", () => {
    for (const [metric, text] of [
      ["revenue", "0"],
      ["revenue", "-5"],
      ["revenue", "12.345"],
      ["revenue", "99999999999"],
      ["bookings", "0"],
      ["bookings", ""],
    ] as const) {
      expect(() => parseTargetInput(metric, text)).toThrow(TargetError);
    }
    try {
      parseTargetInput("revenue", "x");
    } catch (error) {
      expect((error as TargetError).fieldErrors).toHaveProperty("targetValue");
    }
  });

  test("formatting and the input round trip", () => {
    expect(formatTargetValue("revenue", 400_050)).toBe("$4,000.50");
    expect(formatTargetValue("bookings", 30)).toBe("30");
    expect(formatTargetValue("utilisation", 7500)).toBe("75%");
    expect(formatPercentBps(6250)).toBe("62.5%");
    for (const [metric, stored] of [
      ["revenue", 400_050],
      ["bookings", 30],
      ["rebook_rate", 6250],
      ["utilisation", 7500],
    ] as const) {
      expect(parseTargetInput(metric, targetInputValue(metric, stored))).toBe(stored);
    }
  });
});

describe("periods", () => {
  test("a week is Monday to Sunday and a month is the calendar month", () => {
    expect(periodRange("week", TZ, NOW)).toMatchObject({
      from: "2026-11-09",
      to: "2026-11-15",
      days: 7,
      label: "9 Nov to 15 Nov 2026",
    });
    expect(periodRange("month", TZ, NOW)).toMatchObject({
      from: "2026-11-01",
      to: "2026-11-30",
      days: 30,
      label: "November 2026",
    });
    expect(periodRange("month", TZ, NOW, "2026-02-10")).toMatchObject({
      from: "2026-02-01",
      to: "2026-02-28",
      days: 28,
    });
  });

  test("the first Monday-start week across DST still has seven days", () => {
    expect(periodRange("week", TZ, NOW, "2026-10-04")).toMatchObject({
      from: "2026-09-28",
      to: "2026-10-04",
      days: 7,
    });
  });

  test("shiftAnchor steps by a week or a month", () => {
    expect(shiftAnchor(periodRange("week", TZ, NOW), -1)).toBe("2026-11-02");
    expect(shiftAnchor(periodRange("month", TZ, NOW), 1)).toBe("2026-12-01");
  });

  test("elapsed share and ended flag", () => {
    const month = periodRange("month", TZ, NOW);
    expect(elapsedPct(month, TZ, NOW)).toBe(47); // day 14 of 30
    expect(periodEnded(month, TZ, NOW)).toBe(false);
    const oct = periodRange("month", TZ, NOW, "2026-10-01");
    expect(elapsedPct(oct, TZ, NOW)).toBe(100);
    expect(periodEnded(oct, TZ, NOW)).toBe(true);
    const dec = periodRange("month", TZ, NOW, "2026-12-01");
    expect(elapsedPct(dec, TZ, NOW)).toBe(0);
  });
});

describe("pickTarget", () => {
  const base: TargetLike = {
    staffId: "s1",
    metric: "revenue",
    period: "month",
    targetValue: 100,
    validFrom: "2026-01-01",
    validTo: null,
  };
  const nov = periodRange("month", TZ, NOW);

  test("matches person, metric and period type", () => {
    const all = [
      base,
      { ...base, staffId: "s2", targetValue: 1 },
      { ...base, metric: "bookings" as const, targetValue: 2 },
      { ...base, period: "week" as const, targetValue: 3 },
      { ...base, staffId: null, targetValue: 4 },
    ];
    expect(pickTarget(all, { staffId: "s1", metric: "revenue", range: nov })?.targetValue).toBe(
      100,
    );
    expect(pickTarget(all, { staffId: null, metric: "revenue", range: nov })?.targetValue).toBe(4);
    expect(pickTarget(all, { staffId: "s3", metric: "revenue", range: nov })).toBeNull();
  });

  test("respects validity and prefers the latest start", () => {
    const all = [
      { ...base, targetValue: 1, validTo: "2026-10-31" },
      { ...base, targetValue: 2, validFrom: "2026-11-01" },
      { ...base, targetValue: 3, validFrom: "2026-11-15" },
      { ...base, targetValue: 4, validFrom: "2026-12-01" },
    ];
    expect(pickTarget(all, { staffId: "s1", metric: "revenue", range: nov })?.targetValue).toBe(3);
    const oct = periodRange("month", TZ, NOW, "2026-10-10");
    expect(pickTarget(all, { staffId: "s1", metric: "revenue", range: oct })?.targetValue).toBe(1);
  });
});

describe("progressOf", () => {
  test("percentage, bar and status while the period runs", () => {
    expect(progressOf(50, 100, 40, false)).toMatchObject({
      pct: 50,
      barPct: 50,
      status: "on_pace",
    });
    expect(progressOf(30, 100, 40, false)).toMatchObject({ pct: 30, status: "behind" });
    expect(progressOf(40, 100, 40, false).status).toBe("on_pace");
  });

  test("meeting or beating the target is met; the bar stops at 100 but the number does not", () => {
    expect(progressOf(100, 100, 10, false)).toMatchObject({ pct: 100, barPct: 100, status: "met" });
    expect(progressOf(250, 100, 10, false)).toMatchObject({ pct: 250, barPct: 100, status: "met" });
  });

  test("after the period, short of target is missed", () => {
    expect(progressOf(99, 100, 100, true).status).toBe("missed");
    expect(progressOf(100, 100, 100, true).status).toBe("met");
  });

  test("no data is not zero percent", () => {
    expect(progressOf(null, 7500, 50, false)).toEqual({
      actual: null,
      target: 7500,
      pct: null,
      barPct: 0,
      status: "no_data",
    });
    expect(progressOf(0, 100, 50, false)).toMatchObject({ pct: 0, status: "behind" });
  });

  test("rounds to whole percentages", () => {
    expect(progressOf(1, 3, 0, false).pct).toBe(33);
    expect(progressOf(2, 3, 0, false).pct).toBe(67);
  });
});

describe("schemas", () => {
  const ok = { metric: "revenue", period: "month", targetValue: "4000", validFrom: "2026-11-01" };

  test("blank staff means business-wide and blank end date means open ended", () => {
    const parsed = targetFormSchema.parse({ ...ok, staffId: "", validTo: "" });
    expect(parsed.staffId).toBeNull();
    expect(parsed.validTo).toBeNull();
  });

  test("rejects unknown metrics, bad dates and missing values", () => {
    expect(targetFormSchema.safeParse({ ...ok, metric: "tips" }).success).toBe(false);
    expect(targetFormSchema.safeParse({ ...ok, validFrom: "1 Nov" }).success).toBe(false);
    expect(targetFormSchema.safeParse({ ...ok, targetValue: " " }).success).toBe(false);
  });

  test("performance query defaults to the week", () => {
    expect(performanceQuerySchema.parse({})).toEqual({ period: "week" });
    expect(performanceQuerySchema.safeParse({ period: "year" }).success).toBe(false);
  });
});
