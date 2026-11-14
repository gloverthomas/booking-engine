import { describe, expect, test } from "vitest";
import { formatRange, parseRange } from "@/db/tstzrange";

describe("tstzrange helpers", () => {
  test("formats a half-open range in UTC", () => {
    expect(
      formatRange({
        start: new Date("2026-11-21T03:30:00Z"),
        end: new Date("2026-11-21T04:15:00Z"),
      }),
    ).toBe("[2026-11-21T03:30:00.000Z,2026-11-21T04:15:00.000Z)");
  });

  test("parses Postgres output with short and long UTC offsets and quoted bounds", () => {
    const short = parseRange('["2026-11-21 03:30:00+00","2026-11-21 04:15:00+00")');
    expect(short.start.toISOString()).toBe("2026-11-21T03:30:00.000Z");
    expect(short.end.toISOString()).toBe("2026-11-21T04:15:00.000Z");

    const melbourne = parseRange('["2026-11-21 14:30:00+11","2026-11-21 15:15:00+11")');
    expect(melbourne.start.toISOString()).toBe("2026-11-21T03:30:00.000Z");

    const half = parseRange('["2026-11-21 09:00:00+05:30","2026-11-21 10:00:00+05:30")');
    expect(half.start.toISOString()).toBe("2026-11-21T03:30:00.000Z");
  });

  test("round-trips", () => {
    const range = {
      start: new Date("2026-04-05T15:45:00Z"),
      end: new Date("2026-04-05T16:30:00Z"),
    };
    expect(parseRange(formatRange(range))).toEqual(range);
  });

  test("throws on malformed input", () => {
    expect(() => parseRange("[nonsense)")).toThrow(/Cannot parse range/);
    expect(() => parseRange("[foo,bar)")).toThrow(/Cannot parse timestamp/);
  });
});
