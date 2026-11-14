/** OWNER: workstream A. Single place that resolves price and duration (future per-staff and seniority pricing). */
export interface ServicePricing {
  priceCents: number;
  durationMin: number;
}

type Override = { priceCents: number | null; durationMin: number | null } | null | undefined;

/**
 * The one place price and duration are resolved. Precedence, field by field:
 * the stylist's own override (service_staff), then their level's price (service_level_price), then the service.
 */
export function priceFor(
  service: { priceCents: number; durationMin: number },
  staffOverride?: Override,
  levelOverride?: Override,
): ServicePricing {
  return {
    priceCents: staffOverride?.priceCents ?? levelOverride?.priceCents ?? service.priceCents,
    durationMin: staffOverride?.durationMin ?? levelOverride?.durationMin ?? service.durationMin,
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
