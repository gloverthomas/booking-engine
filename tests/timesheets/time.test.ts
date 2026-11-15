import { describe, expect, test } from "vitest";
import {
  formatClockTime,
  formatDuration,
  formatSignedDuration,
  minutesToHours,
  netMinutes,
  parseLocalDateTime,
  weekBounds,
  weekDates,
  weekStartOf,
} from "@/server/timesheets/time";
import { TimesheetError } from "@/server/timesheets/errors";

const TZ = "Australia/Melbourne";

describe("netMinutes", () => {
  test("elapsed minutes minus the break", () => {
    const start = new Date("2026-11-16T22:00:00Z");
    const end = new Date("2026-11-17T06:30:00Z");
    expect(netMinutes(start, end, 30)).toBe(480);
  });

  test("never goes below zero when the break is longer than the shift", () => {
    const start = new Date("2026-11-16T22:00:00Z");
    expect(netMinutes(start, new Date("2026-11-16T22:20:00Z"), 60)).toBe(0);
  });

  test("rounds to the nearest minute", () => {
    const start = new Date("2026-11-16T22:00:00Z");
    expect(netMinutes(start, new Date("2026-11-16T22:10:31Z"), 0)).toBe(11);
  });
});

describe("weeks", () => {
  test("weekStartOf gives the Monday of the local week", () => {
    expect(weekStartOf("2026-11-15", TZ)).toBe("2026-11-09"); // Sunday belongs to the week that began Monday 9th
    expect(weekStartOf("2026-11-16", TZ)).toBe("2026-11-16");
    expect(weekStartOf(new Date("2026-11-15T14:30:00Z"), TZ)).toBe("2026-11-16"); // Mon 1:30am local
  });

  test("weekDates lists seven consecutive days", () => {
    expect(weekDates("2026-11-09")).toEqual([
      "2026-11-09",
      "2026-11-10",
      "2026-11-11",
      "2026-11-12",
      "2026-11-13",
      "2026-11-14",
      "2026-11-15",
    ]);
  });

  test("weekBounds spans local midnight to local midnight, and is 167 hours on the DST start week", () => {
    const normal = weekBounds(TZ, "2026-11-09");
    expect((normal.endExclusive.getTime() - normal.start.getTime()) / 3_600_000).toBe(168);
    // Melbourne clocks went forward on Sun 4 Oct 2026, so that week has 167 hours.
    const dst = weekBounds(TZ, "2026-09-28");
    expect((dst.endExclusive.getTime() - dst.start.getTime()) / 3_600_000).toBe(167);
  });

  test("rejects a bad date", () => {
    expect(() => weekStartOf("2026-13-40", TZ)).toThrow(TimesheetError);
  });
});

describe("parseLocalDateTime", () => {
  test("turns a business-local wall time into the right instant", () => {
    expect(parseLocalDateTime("2026-11-16T09:00", TZ).toISOString()).toBe(
      "2026-11-15T22:00:00.000Z",
    );
    expect(parseLocalDateTime("2026-07-01T09:00", TZ).toISOString()).toBe(
      "2026-06-30T23:00:00.000Z",
    );
  });

  test("rejects garbage and impossible times", () => {
    expect(() => parseLocalDateTime("tomorrow", TZ)).toThrow(TimesheetError);
    expect(() => parseLocalDateTime("2026-02-30T09:00", TZ)).toThrow(TimesheetError);
  });
});

describe("formatting", () => {
  test("formatDuration", () => {
    expect(formatDuration(0)).toBe("0m");
    expect(formatDuration(45)).toBe("45m");
    expect(formatDuration(190)).toBe("3h 10m");
    expect(formatDuration(120)).toBe("2h");
    expect(formatDuration(-90)).toBe("-1h 30m");
  });

  test("formatSignedDuration always shows a sign", () => {
    expect(formatSignedDuration(30)).toBe("+30m");
    expect(formatSignedDuration(-30)).toBe("-30m");
    expect(formatSignedDuration(0)).toBe("0m");
  });

  test("formatClockTime is business local", () => {
    expect(formatClockTime(new Date("2026-11-15T22:02:00Z"), TZ)).toBe("9:02 am");
    expect(formatClockTime(new Date("2026-11-16T05:00:00Z"), TZ)).toBe("4:00 pm");
  });

  test("minutesToHours rounds to two places", () => {
    expect(minutesToHours(450)).toBe(7.5);
    expect(minutesToHours(100)).toBe(1.67);
  });
});
