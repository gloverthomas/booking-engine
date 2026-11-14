import { describe, expect, it } from "vitest";
import {
  addDays,
  addMonths,
  compareDates,
  daysBetween,
  formatClock,
  formatDayHeading,
  formatInstant,
  formatMonthHeading,
  isValidDateString,
  localDateOf,
  monthEnd,
  monthStart,
  weekdayOf,
} from "@/lib/public-api-time";
import { estimateDepositCents, formatAud, formatDuration, sumTotals } from "@/lib/public-api-money";

describe("date helpers", () => {
  it("validates calendar dates strictly", () => {
    expect(isValidDateString("2026-11-20")).toBe(true);
    expect(isValidDateString("2026-02-30")).toBe(false);
    expect(isValidDateString("2026-1-2")).toBe(false);
    expect(isValidDateString("nope")).toBe(false);
  });

  it("adds days across month and DST boundaries without drifting", () => {
    expect(addDays("2026-10-31", 1)).toBe("2026-11-01");
    expect(addDays("2026-10-03", 1)).toBe("2026-10-04"); // Melbourne DST starts
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
    expect(daysBetween("2026-11-01", "2026-11-20")).toBe(19);
    expect(daysBetween("2026-11-20", "2026-11-01")).toBe(-19);
  });

  it("finds weekdays and month bounds", () => {
    expect(weekdayOf("2026-11-15")).toBe(0);
    expect(weekdayOf("2026-11-20")).toBe(5);
    expect(monthStart("2026-11-20")).toBe("2026-11-01");
    expect(monthEnd("2026-11-20")).toBe("2026-11-30");
    expect(monthEnd("2028-02-10")).toBe("2028-02-29");
    expect(addMonths("2026-11-20", 2)).toBe("2027-01-01");
    expect(addMonths("2026-01-20", -1)).toBe("2025-12-01");
  });

  it("compares dates", () => {
    expect(compareDates("2026-01-01", "2026-01-02")).toBe(-1);
    expect(compareDates("2026-01-02", "2026-01-01")).toBe(1);
    expect(compareDates("2026-01-01", "2026-01-01")).toBe(0);
  });

  it("formats headings in en-AU", () => {
    expect(formatDayHeading("2026-11-20")).toBe("Friday 20 November");
    expect(formatMonthHeading("2026-11-20")).toBe("November 2026");
  });

  it("formats instants in the business time zone with lower-case am/pm", () => {
    // 2026-11-20T03:30Z is 2:30 pm in Melbourne (AEDT, UTC+11)
    expect(formatClock("2026-11-20T03:30:00Z", "Australia/Melbourne")).toBe("2:30 pm");
    expect(formatClock("2026-11-19T23:00:00Z", "Australia/Melbourne")).toBe("10:00 am");
    expect(formatInstant("2026-11-20T03:30:00Z", "Australia/Melbourne")).toBe(
      "Friday 20 November, 2:30 pm",
    );
  });

  it("derives the local date of an instant", () => {
    expect(localDateOf("2026-11-19T23:00:00Z", "Australia/Melbourne")).toBe("2026-11-20");
    expect(localDateOf(new Date("2026-11-19T12:00:00Z"), "Australia/Melbourne")).toBe("2026-11-19");
  });
});

describe("money", () => {
  it("formats AUD", () => {
    expect(formatAud(9500)).toBe("$95");
    expect(formatAud(4750)).toBe("$47.50");
    expect(formatAud(0)).toBe("$0");
  });

  it("formats durations", () => {
    expect(formatDuration(45)).toBe("45 min");
    expect(formatDuration(60)).toBe("1 h");
    expect(formatDuration(75)).toBe("1 h 15 min");
  });

  const s = (priceCents: number, durationMin: number, depositPct = 50) => ({
    priceCents,
    durationMin,
    depositPct,
  });

  it("sums totals", () => {
    expect(sumTotals([s(9500, 45), s(3000, 15)])).toEqual({ totalCents: 12500, durationMin: 60 });
    expect(sumTotals([])).toEqual({ totalCents: 0, durationMin: 0 });
  });

  it("estimates the deposit", () => {
    expect(estimateDepositCents([])).toBe(0);
    expect(estimateDepositCents([s(9500, 45), s(3000, 15)])).toBe(6250);
    expect(estimateDepositCents([s(9500, 45, 50), s(3000, 15, 100)])).toBe(4750 + 3000);
  });
});
