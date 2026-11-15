import { describe, expect, test } from "vitest";
import {
  describeTimeOfDay,
  describeWeekdays,
  localMinuteOfDay,
  localWeekday,
  windowAcceptsStart,
  type EntryWindow,
} from "@/server/waitlist/window";
import { local } from "./setup";

const ZONE = "Australia/Melbourne";
const base: EntryWindow = {
  earliestDate: "2026-11-02",
  latestDate: "2026-11-06",
  weekdays: null,
  fromMinute: null,
  toMinute: null,
};

describe("windowAcceptsStart", () => {
  test("accepts any time inside the date range, inclusive of both ends", () => {
    expect(windowAcceptsStart(base, local("2026-11-02T00:00"), ZONE)).toBe(true);
    expect(windowAcceptsStart(base, local("2026-11-06T23:59"), ZONE)).toBe(true);
    expect(windowAcceptsStart(base, local("2026-11-01T23:59"), ZONE)).toBe(false);
    expect(windowAcceptsStart(base, local("2026-11-07T00:00"), ZONE)).toBe(false);
  });

  test("uses the business time zone, not UTC, for the date", () => {
    // 2026-11-02 00:30 Melbourne is still 2026-11-01 in UTC.
    expect(windowAcceptsStart(base, local("2026-11-02T00:30"), ZONE)).toBe(true);
  });

  test("filters by weekday (0 = Sunday)", () => {
    const mondaysOnly = { ...base, weekdays: [1] };
    expect(windowAcceptsStart(mondaysOnly, local("2026-11-02T10:00"), ZONE)).toBe(true);
    expect(windowAcceptsStart(mondaysOnly, local("2026-11-03T10:00"), ZONE)).toBe(false);
    expect(localWeekday(local("2026-11-01T10:00"), ZONE)).toBe(0);
    expect(localWeekday(local("2026-11-07T10:00"), ZONE)).toBe(6);
  });

  test("filters by start minute, inclusive, with one open end", () => {
    const morning = { ...base, fromMinute: 0, toMinute: 719 };
    expect(windowAcceptsStart(morning, local("2026-11-02T11:59"), ZONE)).toBe(true);
    expect(windowAcceptsStart(morning, local("2026-11-02T12:00"), ZONE)).toBe(false);
    const afterTen = { ...base, fromMinute: 600, toMinute: null };
    expect(windowAcceptsStart(afterTen, local("2026-11-02T09:45"), ZONE)).toBe(false);
    expect(windowAcceptsStart(afterTen, local("2026-11-02T16:45"), ZONE)).toBe(true);
    const beforeTen = { ...base, fromMinute: null, toMinute: 600 };
    expect(windowAcceptsStart(beforeTen, local("2026-11-02T10:15"), ZONE)).toBe(false);
    expect(localMinuteOfDay(local("2026-11-02T10:15"), ZONE)).toBe(615);
  });
});

describe("descriptions", () => {
  test("time of day", () => {
    expect(describeTimeOfDay({ fromMinute: null, toMinute: null })).toBe("Any time");
    expect(describeTimeOfDay({ fromMinute: 0, toMinute: 719 })).toBe("Mornings");
    expect(describeTimeOfDay({ fromMinute: 720, toMinute: 1439 })).toBe("Afternoons");
    expect(describeTimeOfDay({ fromMinute: 540, toMinute: 810 })).toBe("9 am to 1:30 pm");
    expect(describeTimeOfDay({ fromMinute: null, toMinute: 600 })).toBe("12 am to 10 am");
  });

  test("weekdays, Monday first", () => {
    expect(describeWeekdays(null)).toBe("Any day");
    expect(describeWeekdays([])).toBe("Any day");
    expect(describeWeekdays([0, 1, 2, 3, 4, 5, 6])).toBe("Any day");
    expect(describeWeekdays([0, 5, 1])).toBe("Mon, Fri, Sun");
  });
});
