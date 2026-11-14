/** OWNER: workstream A. Single place that resolves price and duration (future per-staff and seniority pricing). */
export interface ServicePricing {
  priceCents: number;
  durationMin: number;
}

export function priceFor(
  service: { priceCents: number; durationMin: number },
  override?: { priceCents: number | null; durationMin: number | null } | null,
): ServicePricing {
  return {
    priceCents: override?.priceCents ?? service.priceCents,
    durationMin: override?.durationMin ?? service.durationMin,
  };
}

/** `pct` percent of `cents`, rounded to the nearest cent. */
export function percentOfCents(cents: number, pct: number): number {
  return Math.round((cents * pct) / 100);
}

export interface DepositLine {
  priceCents: number;
  /** Per-service override; null falls back to the business default. */
  depositPct: number | null;
}

/** Deposit due at booking: sum of each line's price times its (override or default) percentage, rounded once. */
export function depositFor(lines: DepositLine[], defaultPct: number): number {
  return Math.round(
    lines.reduce((sum, line) => sum + (line.priceCents * (line.depositPct ?? defaultPct)) / 100, 0),
  );
}
