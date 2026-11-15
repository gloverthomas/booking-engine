import { priceFor } from "@/server/pricing";
import { formatCents, parseDollarsToCents } from "./money";

/** A stylist as the pricing screen needs them. */
export interface PricingStaff {
  id: string;
  name: string;
  level: number;
}

/** One stylist's own price/duration for a service (service_staff). Null = inherit. */
export interface OfferingOverride {
  staffId: string;
  priceCents: number | null;
  durationMin: number | null;
}

/** One seniority row for a service (service_level_price). Null = inherit. */
export interface LevelRow {
  level: number;
  priceCents: number | null;
  durationMin: number | null;
}

/** Where a resolved value came from, in precedence order (see priceFor). */
export type PriceSource = "stylist" | "level" | "service";

export interface EffectiveRow {
  staffId: string;
  name: string;
  level: number;
  priceCents: number;
  durationMin: number;
  priceSource: PriceSource;
  durationSource: PriceSource;
  /** Against the service's own price and duration, so a mistake stands out. */
  priceDeltaCents: number;
  durationDeltaMin: number;
  warnings: string[];
}

function sourceOf(own: number | null | undefined, level: number | null | undefined): PriceSource {
  if (own !== null && own !== undefined) return "stylist";
  if (level !== null && level !== undefined) return "level";
  return "service";
}

/**
 * What each stylist who offers a service will actually charge and take, resolved through priceFor
 * (stylist override, then level price, then the service) with the source of each value.
 */
export function effectivePricing(
  service: { priceCents: number; durationMin: number },
  offerings: readonly OfferingOverride[],
  levelRows: readonly LevelRow[],
  staff: readonly PricingStaff[],
): EffectiveRow[] {
  const people = new Map(staff.map((s) => [s.id, s]));
  const levels = new Map(levelRows.map((r) => [r.level, r]));

  const rows: EffectiveRow[] = [];
  for (const offering of offerings) {
    const person = people.get(offering.staffId);
    if (!person) continue;
    const level = levels.get(person.level);
    const resolved = priceFor(service, offering, level);

    const warnings: string[] = [];
    if (resolved.priceCents === 0) warnings.push("Price is $0");
    if (service.priceCents > 0 && resolved.priceCents > service.priceCents * 2) {
      warnings.push("More than double the service price");
    }

    rows.push({
      staffId: person.id,
      name: person.name,
      level: person.level,
      priceCents: resolved.priceCents,
      durationMin: resolved.durationMin,
      priceSource: sourceOf(offering.priceCents, level?.priceCents),
      durationSource: sourceOf(offering.durationMin, level?.durationMin),
      priceDeltaCents: resolved.priceCents - service.priceCents,
      durationDeltaMin: resolved.durationMin - service.durationMin,
      warnings,
    });
  }
  return rows.sort((a, b) => a.name.localeCompare(b.name));
}

export interface LevelUsage {
  level: number;
  staffNames: string[];
  /** A saved row for a level no stylist holds any more: harmless, but worth cleaning up. */
  unused: boolean;
}

/** One row per seniority level in use (plus any saved row nobody holds), lowest first. */
export function describeLevels(
  staff: readonly PricingStaff[],
  levelRows: readonly LevelRow[],
): LevelUsage[] {
  const byLevel = new Map<number, string[]>();
  for (const person of staff) {
    byLevel.set(person.level, [...(byLevel.get(person.level) ?? []), person.name]);
  }
  for (const row of levelRows) if (!byLevel.has(row.level)) byLevel.set(row.level, []);

  return [...byLevel.entries()]
    .sort(([a], [b]) => a - b)
    .map(([level, names]) => ({
      level,
      staffNames: [...names].sort((a, b) => a.localeCompare(b)),
      unused: names.length === 0,
    }));
}

/** What the service form holds while the owner is typing: strings straight from the inputs. */
export interface PricingDraft {
  price: string;
  durationMin: string;
  offerings: Record<string, { offered: boolean; price: string; durationMin: string }>;
  levels: Record<number, { price: string; durationMin: string }>;
}

function draftCents(value: string | undefined): number | null {
  return value && value.trim() !== "" ? parseDollarsToCents(value) : null;
}

function draftMinutes(value: string | undefined): number | null {
  if (!value || value.trim() === "") return null;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * The effective price table for the values being typed, so the owner sees the result of a change
 * before saving. Anything not yet a valid number counts as "inherit"; saving reports the real error.
 */
export function effectivePricingFromDraft(
  draft: PricingDraft,
  fallback: { priceCents: number; durationMin: number },
  staff: readonly PricingStaff[],
): EffectiveRow[] {
  const service = {
    priceCents: draftCents(draft.price) ?? fallback.priceCents,
    durationMin: draftMinutes(draft.durationMin) ?? fallback.durationMin,
  };
  const offerings: OfferingOverride[] = Object.entries(draft.offerings)
    .filter(([, o]) => o.offered)
    .map(([staffId, o]) => ({
      staffId,
      priceCents: draftCents(o.price),
      durationMin: draftMinutes(o.durationMin),
    }));
  const levelRows: LevelRow[] = Object.entries(draft.levels).map(([level, row]) => ({
    level: Number(level),
    priceCents: draftCents(row.price),
    durationMin: draftMinutes(row.durationMin),
  }));
  return effectivePricing(service, offerings, levelRows, staff);
}

/** "+$10.00", "-$20.00", "+15 min"; empty when nothing changed. */
export function formatDelta(value: number, unit: "money" | "minutes"): string {
  if (value === 0) return "";
  const sign = value > 0 ? "+" : "-";
  const size = Math.abs(value);
  return unit === "money" ? `${sign}${formatCents(size)}` : `${sign}${size} min`;
}
