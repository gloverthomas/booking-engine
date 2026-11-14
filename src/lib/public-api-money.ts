/** Money is integer cents (AUD). Formatting and totals for the public booking pages. */

const wholeFmt = new Intl.NumberFormat("en-AU", {
  style: "currency",
  currency: "AUD",
  minimumFractionDigits: 0,
  maximumFractionDigits: 0,
});

const centsFmt = new Intl.NumberFormat("en-AU", {
  style: "currency",
  currency: "AUD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/** "$95" for whole dollars, "$47.50" otherwise. */
export function formatAud(cents: number): string {
  return cents % 100 === 0 ? wholeFmt.format(cents / 100) : centsFmt.format(cents / 100);
}

/** "45 min", "1 h", "1 h 15 min". */
export function formatDuration(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m} min`;
  if (m === 0) return `${h} h`;
  return `${h} h ${m} min`;
}

export interface PricedService {
  priceCents: number;
  durationMin: number;
  /** Effective deposit percentage for this service (0-100). */
  depositPct: number;
}

export function sumTotals(services: readonly PricedService[]): {
  totalCents: number;
  durationMin: number;
} {
  return services.reduce(
    (acc, s) => ({
      totalCents: acc.totalCents + s.priceCents,
      durationMin: acc.durationMin + s.durationMin,
    }),
    { totalCents: 0, durationMin: 0 },
  );
}

/**
 * Display-only estimate of the deposit before a hold exists. The authoritative figure comes
 * back from the server with the hold (workstream A owns the rule).
 */
export function estimateDepositCents(services: readonly PricedService[]): number {
  if (services.length === 0) return 0;
  const first = services[0].depositPct;
  if (services.every((s) => s.depositPct === first)) {
    const { totalCents } = sumTotals(services);
    return Math.round((totalCents * first) / 100);
  }
  return services.reduce((acc, s) => acc + Math.round((s.priceCents * s.depositPct) / 100), 0);
}
