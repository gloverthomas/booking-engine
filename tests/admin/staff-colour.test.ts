import { describe, expect, test } from "vitest";
import {
  assignStaffColours,
  readableTextColour,
  resolveStaffColour,
  STAFF_PALETTE,
} from "@/server/admin/staff-colour";

describe("resolveStaffColour", () => {
  test("uses a valid stored hex, normalised to lower case", () => {
    expect(resolveStaffColour("#D33A1E", 3)).toBe("#d33a1e");
    expect(resolveStaffColour(" #d33a1e ", 0)).toBe("#d33a1e");
  });

  test("falls back to a stable palette colour by order", () => {
    expect(resolveStaffColour(null, 0)).toBe(STAFF_PALETTE[0]);
    expect(resolveStaffColour(undefined, 2)).toBe(STAFF_PALETTE[2]);
    expect(resolveStaffColour("red", 1)).toBe(STAFF_PALETTE[1]);
    expect(resolveStaffColour("#fff", 1)).toBe(STAFF_PALETTE[1]);
  });

  test("wraps past the palette and survives a bad index", () => {
    expect(resolveStaffColour(null, STAFF_PALETTE.length)).toBe(STAFF_PALETTE[0]);
    expect(resolveStaffColour(null, -1)).toBe(STAFF_PALETTE[0]);
    expect(resolveStaffColour(null, Number.NaN)).toBe(STAFF_PALETTE[0]);
  });

  test("palette colours are distinct and all read with white text", () => {
    expect(new Set(STAFF_PALETTE).size).toBe(STAFF_PALETTE.length);
    for (const colour of STAFF_PALETTE) expect(readableTextColour(colour)).toBe("#ffffff");
  });
});

describe("assignStaffColours", () => {
  test("a person keeps their colour when someone is added after them", () => {
    const before = assignStaffColours([
      { id: "a", colour: null },
      { id: "b", colour: null },
    ]);
    const after = assignStaffColours([
      { id: "a", colour: null },
      { id: "b", colour: null },
      { id: "c", colour: null },
    ]);
    expect(after.get("a")).toBe(before.get("a"));
    expect(after.get("b")).toBe(before.get("b"));
    expect(after.get("c")).toBe(STAFF_PALETTE[2]);
  });

  test("an explicit colour wins but still occupies its place in the order", () => {
    const map = assignStaffColours([
      { id: "a", colour: "#123456" },
      { id: "b", colour: null },
    ]);
    expect(map.get("a")).toBe("#123456");
    expect(map.get("b")).toBe(STAFF_PALETTE[1]);
  });
});

describe("readableTextColour", () => {
  test("dark text on light backgrounds, white on dark, white for junk", () => {
    expect(readableTextColour("#fde68a")).toBe("#1c1917");
    expect(readableTextColour("#0f5c5c")).toBe("#ffffff");
    expect(readableTextColour("nonsense")).toBe("#ffffff");
  });
});
