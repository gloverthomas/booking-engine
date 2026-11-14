import { describe, expect, test } from "vitest";
import { allocateProRata, formatAud } from "@/server/reports/money";
import { escapeCsvCell, guardFormula, toCsv } from "@/server/reports/csv";
import {
  bucketLabel,
  bucketStart,
  defaultRange,
  eachLocalDate,
  listBuckets,
  localDateOf,
  rangePresets,
  resolveRange,
} from "@/server/reports/range";

const TZ = "Australia/Melbourne";

describe("allocateProRata", () => {
  test("always sums exactly to the amount", () => {
    for (const amount of [1, 7, 100, 9999, 12345]) {
      const parts = allocateProRata(amount, [9500, 3000, 1234]);
      expect(parts.reduce((a, b) => a + b, 0)).toBe(amount);
    }
  });
  test("splits proportionally", () => {
    expect(allocateProRata(6250, [9500, 3000])).toEqual([4750, 1500]);
  });
  test("zero weights go to the first part, empty gives empty", () => {
    expect(allocateProRata(500, [0, 0])).toEqual([500, 0]);
    expect(allocateProRata(500, [])).toEqual([]);
  });
});

describe("formatAud", () => {
  test("formats dollars and negatives", () => {
    expect(formatAud(4750)).toBe("$47.50");
    expect(formatAud(-1250)).toBe("-$12.50");
    expect(formatAud(123456789)).toBe("$1,234,567.89");
  });
});

describe("csv", () => {
  test("guards formula injection in text cells", () => {
    for (const evil of ["=1+1", "+SUM(A1)", "-2+3", "@cmd", "\tcmd", "\rcmd", "  =HYPERLINK(x)"]) {
      expect(guardFormula(evil).startsWith("'")).toBe(true);
    }
    expect(guardFormula("Sam")).toBe("Sam");
    expect(guardFormula("a=b")).toBe("a=b");
  });

  test("escapes commas, quotes and newlines", () => {
    expect(escapeCsvCell('He said "hi", ok')).toBe('"He said ""hi"", ok"');
    expect(escapeCsvCell("line1\nline2")).toBe('"line1\nline2"');
    expect(escapeCsvCell("plain")).toBe("plain");
  });

  test("builds a CSV with typed numeric columns that stay numeric when negative", () => {
    const csv = toCsv(
      [
        { key: "name", header: "Name" },
        { key: "cents", header: "Amount", type: "money" },
        { key: "n", header: "Count", type: "int" },
        { key: "pct", header: "Pct", type: "percent" },
        { key: "d", header: "Hours", type: "decimal" },
      ],
      [
        { name: "=cmd|' /C calc'!A0", cents: -1250, n: 3.9, pct: 12.345, d: 1.5 },
        { name: null, cents: null, n: Number.NaN, pct: "x", d: undefined },
      ],
    );
    const lines = csv.replace("\uFEFF", "").split("\r\n");
    expect(csv.startsWith("\uFEFF")).toBe(true);
    expect(lines[0]).toBe("Name,Amount,Count,Pct,Hours");
    expect(lines[1]).toBe("'=cmd|' /C calc'!A0,-12.50,3,12.3,1.50");
    expect(lines[2]).toBe(",,,,");
  });

  test("guards a hostile header too", () => {
    expect(toCsv([{ key: "a", header: "=bad" }], [])).toContain("'=bad");
  });
});

describe("range helpers", () => {
  test("resolves DST-safe instants (Melbourne is UTC+11 in November)", () => {
    const r = resolveRange(TZ, "2026-11-01", "2026-11-30");
    expect(r.start.toISOString()).toBe("2026-10-31T13:00:00.000Z");
    expect(r.endExclusive.toISOString()).toBe("2026-11-30T13:00:00.000Z");
  });
  test("a range over the spring-forward day is 23h long for that day", () => {
    const r = resolveRange(TZ, "2026-10-04", "2026-10-04");
    expect(r.endExclusive.getTime() - r.start.getTime()).toBe(23 * 3600_000);
  });
  test("localDateOf and bucketStart use the business zone", () => {
    const instant = new Date("2026-11-02T22:00:00Z");
    expect(localDateOf(instant, TZ)).toBe("2026-11-03");
    expect(bucketStart(instant, "day", TZ)).toBe("2026-11-03");
    expect(bucketStart(instant, "week", TZ)).toBe("2026-11-02");
    expect(bucketStart(instant, "month", TZ)).toBe("2026-11-01");
  });
  test("lists buckets and dates", () => {
    const r = resolveRange(TZ, "2026-10-28", "2026-12-02");
    expect(listBuckets(r, "month")).toEqual(["2026-10-01", "2026-11-01", "2026-12-01"]);
    expect(eachLocalDate(resolveRange(TZ, "2026-11-01", "2026-11-03"))).toEqual([
      "2026-11-01",
      "2026-11-02",
      "2026-11-03",
    ]);
  });
  test("labels", () => {
    expect(bucketLabel("2026-11-01", "month")).toBe("Nov 2026");
    expect(bucketLabel("2026-11-02", "week")).toBe("Wk of 2 Nov");
    expect(bucketLabel("2026-11-03", "day")).toBe("Tue 3 Nov");
  });
  test("presets and default range", () => {
    const now = new Date("2026-11-14T01:00:00Z");
    const presets = rangePresets(now, TZ);
    expect(presets.find((p) => p.id === "last_month")).toMatchObject({
      from: "2026-10-01",
      to: "2026-10-31",
    });
    expect(presets.find((p) => p.id === "last_30")).toMatchObject({
      from: "2026-10-16",
      to: "2026-11-14",
    });
    expect(defaultRange(now, TZ)).toEqual({ from: "2026-11-01", to: "2026-11-14" });
  });
});
