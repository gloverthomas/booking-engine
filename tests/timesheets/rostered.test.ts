import { describe, expect, test } from "vitest";
import {
  rosterIntervalsForDay,
  rosterSegmentsForDay,
  rosteredMinutesForDay,
  type ExceptionLike,
  type RuleLike,
} from "@/server/timesheets/rostered";

const TZ = "Australia/Melbourne";
const NORTH = "loc-north";
const SOUTH = "loc-south";

const rule = (over: Partial<RuleLike> = {}): RuleLike => ({
  locationId: NORTH,
  weekday: 1, // Monday
  startMinute: 9 * 60,
  endMinute: 17 * 60,
  validFrom: null,
  validTo: null,
  ...over,
});
const exception = (over: Partial<ExceptionLike> = {}): ExceptionLike => ({
  locationId: null,
  date: "2026-11-16",
  kind: "off",
  startMinute: null,
  endMinute: null,
  ...over,
});

// Monday 16 Nov 2026.
const DAY = "2026-11-16";

describe("rosterSegmentsForDay", () => {
  test("uses the weekly rule for that weekday only", () => {
    expect(rosterSegmentsForDay([rule()], [], DAY)).toEqual([
      { locationId: NORTH, startMinute: 540, endMinute: 1020 },
    ]);
    expect(rosterSegmentsForDay([rule({ weekday: 2 })], [], DAY)).toEqual([]);
  });

  test("respects validFrom and validTo", () => {
    expect(rosterSegmentsForDay([rule({ validFrom: "2026-11-17" })], [], DAY)).toEqual([]);
    expect(rosterSegmentsForDay([rule({ validTo: "2026-11-15" })], [], DAY)).toEqual([]);
    expect(rosterSegmentsForDay([rule({ validFrom: DAY, validTo: DAY })], [], DAY)).toHaveLength(1);
  });

  test("an everywhere day off removes everything", () => {
    expect(rosterSegmentsForDay([rule(), rule({ locationId: SOUTH })], [exception()], DAY)).toEqual(
      [],
    );
  });

  test("a day off at one location leaves the other", () => {
    const segments = rosterSegmentsForDay(
      [rule(), rule({ locationId: SOUTH, startMinute: 1020, endMinute: 1140 })],
      [exception({ locationId: NORTH })],
      DAY,
    );
    expect(segments).toEqual([{ locationId: SOUTH, startMinute: 1020, endMinute: 1140 }]);
  });

  test("a custom day at a location replaces that location's rules", () => {
    const segments = rosterSegmentsForDay(
      [rule()],
      [exception({ kind: "custom", locationId: NORTH, startMinute: 600, endMinute: 780 })],
      DAY,
    );
    expect(segments).toEqual([{ locationId: NORTH, startMinute: 600, endMinute: 780 }]);
  });

  test("a custom day with no location replaces the whole day and keeps the first location", () => {
    const segments = rosterSegmentsForDay(
      [rule(), rule({ locationId: SOUTH, startMinute: 1020, endMinute: 1140 })],
      [exception({ kind: "custom", startMinute: 600, endMinute: 780 })],
      DAY,
    );
    expect(segments).toEqual([{ locationId: NORTH, startMinute: 600, endMinute: 780 }]);
  });

  test("a custom day on a day with no rules still rosters the person", () => {
    const segments = rosterSegmentsForDay(
      [],
      [exception({ kind: "custom", startMinute: 600, endMinute: 780 })],
      DAY,
    );
    expect(segments).toEqual([{ locationId: null, startMinute: 600, endMinute: 780 }]);
  });

  test("ignores exceptions on other dates", () => {
    expect(rosterSegmentsForDay([rule()], [exception({ date: "2026-11-17" })], DAY)).toHaveLength(
      1,
    );
  });
});

describe("rosteredMinutesForDay", () => {
  test("sums the day's hours", () => {
    expect(rosteredMinutesForDay([rule()], [], DAY, TZ)).toBe(480);
  });

  test("overlapping segments are not counted twice", () => {
    const rules = [rule(), rule({ locationId: SOUTH, startMinute: 960, endMinute: 1080 })];
    // 9-17 and 16-18 overlap by an hour: 9 hours in total.
    expect(rosteredMinutesForDay(rules, [], DAY, TZ)).toBe(540);
  });

  test("is DST safe: a full-day roster is 23 hours on the spring-forward day and 25 on the fall-back day", () => {
    const allDay = (weekday: number) => rule({ weekday, startMinute: 0, endMinute: 1440 });
    // Sunday 4 Oct 2026 clocks go forward (2am to 3am); Sunday 5 Apr 2026 clocks go back.
    expect(rosteredMinutesForDay([allDay(0)], [], "2026-10-04", TZ)).toBe(23 * 60);
    expect(rosteredMinutesForDay([allDay(0)], [], "2026-04-05", TZ)).toBe(25 * 60);
  });

  test("a 1am to 5am shift across the DST start is three real hours", () => {
    const night = rule({ weekday: 0, startMinute: 60, endMinute: 300 });
    expect(rosteredMinutesForDay([night], [], "2026-10-04", TZ)).toBe(3 * 60);
  });
});

describe("rosterIntervalsForDay", () => {
  test("returns instants with the location attached", () => {
    const [interval] = rosterIntervalsForDay([rule()], [], DAY, TZ);
    expect(interval.locationId).toBe(NORTH);
    expect(new Date(interval.start).toISOString()).toBe("2026-11-15T22:00:00.000Z");
    expect(new Date(interval.end).toISOString()).toBe("2026-11-16T06:00:00.000Z");
  });
});
