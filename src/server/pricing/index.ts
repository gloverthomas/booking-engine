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
