import { describe, expect, test } from "vitest";
import {
  centsToInputValue,
  formatCents,
  parseDollarsToCents,
} from "@/server/admin-foundation/money";

describe("parseDollarsToCents", () => {
  test.each([
    ["95", 9500],
    ["95.00", 9500],
    ["95.5", 9550],
    ["$126", 12600],
    [" $1,095.05 ", 109505],
    ["0", 0],
    ["0.99", 99],
    [".5", 50],
  ])("parses %s as %i cents without floating point drift", (input, cents) => {
    expect(parseDollarsToCents(input)).toBe(cents);
  });

  test.each(["", "  ", "abc", "-5", "1.234", "1e3", "12.3.4", "$", "1,00"])(
    "rejects %j",
    (input) => {
      expect(parseDollarsToCents(input)).toBeNull();
    },
  );

  test("handles values that break naive float maths", () => {
    expect(parseDollarsToCents("19.99")).toBe(1999);
    expect(parseDollarsToCents("1.15")).toBe(115);
    expect(parseDollarsToCents("8.2")).toBe(820);
  });
});

describe("formatCents", () => {
  test("shows dollars with two decimals", () => {
    expect(formatCents(9500)).toBe("$95.00");
    expect(formatCents(12650)).toBe("$126.50");
    expect(formatCents(5)).toBe("$0.05");
    expect(formatCents(0)).toBe("$0.00");
    expect(formatCents(109505)).toBe("$1,095.05");
  });
});

describe("centsToInputValue", () => {
  test("gives a plain decimal string suitable for an input", () => {
    expect(centsToInputValue(9500)).toBe("95.00");
    expect(centsToInputValue(1999)).toBe("19.99");
    expect(centsToInputValue(5)).toBe("0.05");
    expect(centsToInputValue(null)).toBe("");
  });
});
