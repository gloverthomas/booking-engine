import { describe, expect, test } from "vitest";
import {
  fromWallClock,
  fromWallClockInput,
  toWallClock,
  toWallClockInput,
} from "@/components/admin/calendar/wallclock";

const TZ = "Australia/Melbourne";

describe("wall clock helpers", () => {
  test("toWallClock renders a Melbourne local time as a UTC-coerced date", () => {
    // 2026-11-14T00:00Z is 11:00 AEDT
    const wall = toWallClock(new Date("2026-11-14T00:00:00Z"), TZ);
    expect(wall.toISOString()).toBe("2026-11-14T11:00:00.000Z");
  });

  test("fromWallClock is the inverse in summer and winter", () => {
    for (const iso of ["2026-11-14T00:00:00Z", "2026-07-14T00:00:00Z"]) {
      const date = new Date(iso);
      expect(fromWallClock(toWallClock(date, TZ), TZ).toISOString()).toBe(date.toISOString());
    }
  });

  test("handles the daylight saving changeover day", () => {
    // DST ends Sunday 5 April 2026 at 03:00 AEDT. 09:00 local that day is AEST (+10).
    const wall = new Date("2026-04-05T09:00:00Z");
    expect(fromWallClock(wall, TZ).toISOString()).toBe("2026-04-04T23:00:00.000Z");
  });

  test("datetime-local inputs are interpreted in the business zone", () => {
    const date = fromWallClockInput("2026-11-14T11:00", TZ);
    expect(date?.toISOString()).toBe("2026-11-14T00:00:00.000Z");
    expect(toWallClockInput(date as Date, TZ)).toBe("2026-11-14T11:00");
  });

  test("invalid input returns null", () => {
    expect(fromWallClockInput("", TZ)).toBeNull();
    expect(fromWallClockInput("not a date", TZ)).toBeNull();
  });
});
