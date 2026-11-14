import { describe, expect, test } from "vitest";
import {
  copyDay,
  emptyWeek,
  hhmmToMinutes,
  minutesToHhmm,
  rulesToWeek,
  validateRanges,
  weekToRules,
  WEEKDAYS_MON_FIRST,
} from "@/server/admin-foundation/week";

describe("hh:mm conversion", () => {
  test("round-trips minutes since local midnight", () => {
    expect(minutesToHhmm(0)).toBe("00:00");
    expect(minutesToHhmm(9 * 60 + 5)).toBe("09:05");
    expect(minutesToHhmm(1440)).toBe("24:00");
    expect(hhmmToMinutes("09:05")).toBe(545);
    expect(hhmmToMinutes("24:00")).toBe(1440);
    expect(hhmmToMinutes("7:30")).toBe(450);
  });

  test("rejects malformed times", () => {
    for (const bad of ["", "9", "25:00", "12:60", "ab:cd", "24:01", "-1:00"]) {
      expect(hhmmToMinutes(bad)).toBeNull();
    }
  });
});

describe("validateRanges", () => {
  test("accepts sorted non-overlapping ranges, including touching ones", () => {
    expect(
      validateRanges([
        { startMinute: 540, endMinute: 720 },
        { startMinute: 720, endMinute: 1020 },
      ]),
    ).toBeNull();
    expect(validateRanges([])).toBeNull();
  });

  test("rejects empty, reversed and out-of-range ranges", () => {
    expect(validateRanges([{ startMinute: 600, endMinute: 600 }])).toMatch(/after/i);
    expect(validateRanges([{ startMinute: 700, endMinute: 600 }])).toMatch(/after/i);
    expect(validateRanges([{ startMinute: -1, endMinute: 600 }])).toMatch(/00:00/);
    expect(validateRanges([{ startMinute: 600, endMinute: 1441 }])).toMatch(/24:00/);
  });

  test("rejects overlaps regardless of input order", () => {
    expect(
      validateRanges([
        { startMinute: 600, endMinute: 800 },
        { startMinute: 540, endMinute: 660 },
      ]),
    ).toMatch(/overlap/i);
  });
});

describe("week helpers", () => {
  test("shows Monday first and Sunday last", () => {
    expect(WEEKDAYS_MON_FIRST.map((d) => d.index)).toEqual([1, 2, 3, 4, 5, 6, 0]);
    expect(WEEKDAYS_MON_FIRST[0]?.label).toBe("Monday");
  });

  test("builds a week from rules, sorted per day, and back", () => {
    const week = rulesToWeek([
      { weekday: 1, startMinute: 780, endMinute: 1020 },
      { weekday: 1, startMinute: 540, endMinute: 720 },
      { weekday: 6, startMinute: 540, endMinute: 960 },
    ]);
    expect(week[1]).toEqual([
      { startMinute: 540, endMinute: 720 },
      { startMinute: 780, endMinute: 1020 },
    ]);
    expect(week[0]).toEqual([]);
    expect(weekToRules(week)).toEqual([
      { weekday: 1, startMinute: 540, endMinute: 720 },
      { weekday: 1, startMinute: 780, endMinute: 1020 },
      { weekday: 6, startMinute: 540, endMinute: 960 },
    ]);
  });

  test("copyDay replaces the target days with a copy and leaves the source and others alone", () => {
    const week = rulesToWeek([
      { weekday: 1, startMinute: 540, endMinute: 1020 },
      { weekday: 2, startMinute: 600, endMinute: 660 },
      { weekday: 3, startMinute: 600, endMinute: 660 },
    ]);
    const next = copyDay(week, 1, [2, 4]);
    expect(next[2]).toEqual([{ startMinute: 540, endMinute: 1020 }]);
    expect(next[4]).toEqual([{ startMinute: 540, endMinute: 1020 }]);
    expect(next[3]).toEqual([{ startMinute: 600, endMinute: 660 }]);
    expect(next[1]).toEqual(week[1]);
    // immutable: original untouched and ranges are not shared by reference
    expect(week[2]).toEqual([{ startMinute: 600, endMinute: 660 }]);
    expect(next[2]?.[0]).not.toBe(week[1]?.[0]);
  });

  test("copyDay ignores the source day if listed as a target", () => {
    const week = rulesToWeek([{ weekday: 1, startMinute: 540, endMinute: 1020 }]);
    expect(copyDay(week, 1, [1])).toEqual(week);
  });

  test("emptyWeek has seven empty days", () => {
    expect(emptyWeek()).toHaveLength(7);
    expect(emptyWeek().every((d) => d.length === 0)).toBe(true);
  });
});
