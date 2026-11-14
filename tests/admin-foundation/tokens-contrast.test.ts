import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

const css = readFileSync("src/app/globals.css", "utf8");

function tokensIn(block: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const match of block.matchAll(/--c-([a-z-]+):\s*(#[0-9a-fA-F]{6});/g)) {
    out[match[1] as string] = match[2] as string;
  }
  return out;
}

const darkStart = css.indexOf("@media (prefers-color-scheme: dark)");
const light = tokensIn(css.slice(0, darkStart));
const dark = { ...light, ...tokensIn(css.slice(darkStart)) };

function luminance(hex: string): number {
  const n = Number.parseInt(hex.slice(1), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function ratio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** [foreground, background, minimum ratio, what it is] */
const PAIRS: Array<[string, string, number, string]> = [
  ["ink", "paper", 4.5, "body text"],
  ["ink", "surface", 4.5, "text on cards and inputs"],
  ["ink", "peach", 4.5, "text on peach"],
  ["ink", "sunken", 4.5, "text on wells and table heads"],
  ["ink-muted", "paper", 4.5, "secondary text"],
  ["ink-muted", "surface", 4.5, "secondary text on cards"],
  ["ink-subtle", "paper", 4.5, "hints and eyebrows"],
  ["ink-subtle", "surface", 4.5, "hints on cards"],
  ["ink-subtle", "peach", 4.5, "hints on peach"],
  ["ink-subtle", "sunken", 4.5, "hints on wells"],
  ["on-primary", "primary", 4.5, "primary button label"],
  ["on-danger", "danger", 4.5, "danger button label"],
  ["success", "success-tint", 4.5, "success badge"],
  ["warning", "warning-tint", 4.5, "warning badge"],
  ["danger", "danger-tint", 4.5, "error badge and message"],
  ["info", "info-tint", 4.5, "info badge"],
  ["danger", "surface", 4.5, "inline error text on cards"],
  ["line-strong", "paper", 3, "control border on page"],
  ["line-strong", "surface", 3, "control border on cards"],
  ["focus", "paper", 3, "focus ring on page"],
  ["focus", "surface", 3, "focus ring on cards"],
  ["focus", "peach", 3, "focus ring on peach"],
];

describe.each([
  ["light", light],
  ["dark", dark],
] as const)("%s theme contrast (WCAG AA)", (_name, theme) => {
  test.each(PAIRS)("%s on %s is at least %s:1 (%s)", (fg, bg, min) => {
    const a = theme[fg];
    const b = theme[bg];
    expect(a, `missing token --c-${fg}`).toBeDefined();
    expect(b, `missing token --c-${bg}`).toBeDefined();
    expect(ratio(a as string, b as string)).toBeGreaterThanOrEqual(min);
  });
});

describe("accessibility basics in the stylesheet", () => {
  test("defines a visible focus ring, a 44px tap target token and reduced-motion handling", () => {
    expect(css).toMatch(/:focus-visible\s*{[^}]*outline:\s*3px/);
    expect(css).toMatch(/--tap:\s*2\.75rem/);
    expect(css).toMatch(/prefers-reduced-motion:\s*reduce/);
  });
});
