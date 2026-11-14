/**
 * Split an integer amount across weights so the parts always sum to the amount exactly
 * (largest remainder method, ties broken by position). Zero total weight puts everything in the first part.
 */
export function allocateProRata(amountCents: number, weights: readonly number[]): number[] {
  if (weights.length === 0) return [];
  const total = weights.reduce((sum, w) => sum + w, 0);
  if (total <= 0) return weights.map((_, i) => (i === 0 ? amountCents : 0));
  const exact = weights.map((w) => (amountCents * w) / total);
  const floors = exact.map((x) => Math.floor(x));
  let remainder = amountCents - floors.reduce((sum, f) => sum + f, 0);
  const order = exact
    .map((x, i) => ({ i, frac: x - Math.floor(x) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  const result = [...floors];
  for (const { i } of order) {
    if (remainder <= 0) break;
    result[i] += 1;
    remainder -= 1;
  }
  return result;
}

/** Display format for AUD, e.g. -1250 -> "-$12.50". */
export function formatAud(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(Math.round(cents));
  const dollars = Math.floor(abs / 100).toLocaleString("en-AU");
  return `${sign}$${dollars}.${String(abs % 100).padStart(2, "0")}`;
}
