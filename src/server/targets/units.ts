import { formatAud } from "../reports/money";
import { TargetError } from "./errors";

export const TARGET_METRICS = ["revenue", "bookings", "rebook_rate", "utilisation"] as const;
export type TargetMetric = (typeof TARGET_METRICS)[number];

export const TARGET_METRIC_LABEL: Record<TargetMetric, string> = {
  revenue: "Revenue",
  bookings: "Appointments",
  rebook_rate: "Rebook rate",
  utilisation: "Utilisation",
};

/** Largest stored value we accept (the column is a 32-bit integer): $10 million, 100,000 bookings, 100%. */
export const MAX_STORED: Record<TargetMetric, number> = {
  revenue: 1_000_000_000,
  bookings: 100_000,
  rebook_rate: 10_000,
  utilisation: 10_000,
};

export const isRateMetric = (metric: TargetMetric): boolean =>
  metric === "rebook_rate" || metric === "utilisation";

const MONEY = /^\$?\s*(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?$/;
const PERCENT = /^(\d{1,3})(?:\.(\d{1,2}))?\s*%?$/;
const COUNT = /^\d{1,6}$/;

function bad(metric: TargetMetric): never {
  const hint =
    metric === "revenue"
      ? "Enter dollars, like 4000 or 4,000.50."
      : metric === "bookings"
        ? "Enter a whole number of appointments."
        : "Enter a percentage from 1 to 100, like 75 or 62.5.";
  throw new TargetError("bad_target_value", hint, { targetValue: hint });
}

/**
 * Human text to the stored unit: revenue in cents, bookings as a count, rates in basis points (10000 = 100%).
 * Integer arithmetic only, so "4000.10" is exactly 400010 cents.
 */
export function parseTargetInput(metric: TargetMetric, text: string): number {
  const trimmed = text.trim();
  let value: number;
  if (metric === "revenue") {
    const m = MONEY.exec(trimmed);
    if (!m) return bad(metric);
    value = Number(m[1].replaceAll(",", "")) * 100 + Number((m[2] ?? "").padEnd(2, "0"));
  } else if (metric === "bookings") {
    if (!COUNT.test(trimmed)) return bad(metric);
    value = Number(trimmed);
  } else {
    const m = PERCENT.exec(trimmed);
    if (!m) return bad(metric);
    value = Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0"));
  }
  if (value <= 0 || value > MAX_STORED[metric]) return bad(metric);
  return value;
}

/** Stored value to display text: "$4,000.00", "30", "62.5%". */
export function formatTargetValue(metric: TargetMetric, stored: number): string {
  if (metric === "revenue") return formatAud(stored);
  if (metric === "bookings") return String(stored);
  return `${formatPercentBps(stored)}`;
}

/** Basis points as a percentage with up to two decimals: 6250 -> "62.5%". */
export function formatPercentBps(bps: number): string {
  return `${Number((bps / 100).toFixed(2))}%`;
}

/** Stored value back into an input box (no symbols, so parseTargetInput reads it again). */
export function targetInputValue(metric: TargetMetric, stored: number): string {
  if (metric === "revenue") return (stored / 100).toFixed(2);
  if (metric === "bookings") return String(stored);
  return String(Number((stored / 100).toFixed(2)));
}
