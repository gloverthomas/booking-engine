/** Money is stored as integer cents (AUD). Dollars only exist at the edge: inputs and display. */

const DOLLARS = /^\$?\s*(\d{1,3}(?:,\d{3})+|\d+)?(?:\.(\d{1,2}))?$/;

/** Parse "95", "$95.50", "1,095.05" into integer cents. Returns null for anything ambiguous or negative. */
export function parseDollarsToCents(input: string): number | null {
  const trimmed = input.trim();
  const match = DOLLARS.exec(trimmed);
  if (!match) return null;
  const [, whole, fraction] = match;
  if (whole === undefined && fraction === undefined) return null;
  const dollars = Number((whole ?? "0").replaceAll(",", ""));
  const cents = Number((fraction ?? "").padEnd(2, "0") || "0");
  const total = dollars * 100 + cents;
  return Number.isSafeInteger(total) ? total : null;
}

const aud = new Intl.NumberFormat("en-AU", { style: "currency", currency: "AUD" });

/** "$95.00" */
export function formatCents(cents: number): string {
  return aud.format(cents / 100);
}

/** "95.00" for form inputs; empty string for null. */
export function centsToInputValue(cents: number | null | undefined): string {
  if (cents === null || cents === undefined) return "";
  const whole = Math.trunc(cents / 100);
  const frac = String(Math.abs(cents % 100)).padStart(2, "0");
  return `${whole}.${frac}`;
}
