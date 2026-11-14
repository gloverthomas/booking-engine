import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

const css = readFileSync(new URL("../src/app/globals.css", import.meta.url), "utf8");

function token(name: string): string {
  const match = css.match(new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})`));
  if (!match) throw new Error(`token --${name} not found`);
  return match[1];
}

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5]
    .map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function ratio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

describe("colour contrast (WCAG AA for normal text is 4.5)", () => {
  const pairs: Array<[string, string, string]> = [
    ["ink on paper", "ink", "paper"],
    ["ink on sheet", "ink", "sheet"],
    ["ink on paper-deep", "ink", "paper-deep"],
    ["muted ink on paper", "ink-soft", "paper"],
    ["muted ink on sheet", "ink-soft", "sheet"],
    ["paper on ink", "paper", "ink"],
    ["white on signal", "on-signal", "signal"],
    ["signal on paper (large text only)", "signal", "paper"],
  ];
  for (const [label, fg, bg] of pairs) {
    test(label, () => {
      const min = label.includes("large") ? 3 : 4.5;
      expect(ratio(token(fg), token(bg))).toBeGreaterThanOrEqual(min);
    });
  }
});
