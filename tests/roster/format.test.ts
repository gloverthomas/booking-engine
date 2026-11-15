import { describe, expect, test } from "vitest";
import { formatDayLabel, formatMinute, formatMinuteRange } from "@/server/roster/format";

describe("formatMinute", () => {
  test.each([
    [0, "12am"],
    [60, "1am"],
    [540, "9am"],
    [570, "9:30am"],
    [720, "12pm"],
    [735, "12:15pm"],
    [1020, "5pm"],
    [1439, "11:59pm"],
    [1440, "12am"],
  ])("%i -> %s", (minute, expected) => {
    expect(formatMinute(minute)).toBe(expected);
  });
});

test("formatMinuteRange joins start and end", () => {
  expect(formatMinuteRange({ startMinute: 540, endMinute: 1020 })).toBe("9am to 5pm");
});

test("formatDayLabel gives a short weekday, day and month", () => {
  expect(formatDayLabel("2026-11-02")).toBe("Mon 2 Nov");
  expect(formatDayLabel("2026-12-25")).toBe("Fri 25 Dec");
});
