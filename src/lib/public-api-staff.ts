import { estimateDepositCents } from "./public-api-money";
import type { CatalogService, CatalogStaff } from "./public-api-types";

/**
 * Pure helpers for "choose your stylist". Shared by the API (to price a slot) and the booking page
 * (to list and price stylists). The numbers always come from the catalog, which resolves them
 * through priceFor on the server; nothing here decides a price.
 */

export interface QuoteLine {
  id: string;
  name: string;
  priceCents: number;
  durationMin: number;
}

export interface Quote {
  totalCents: number;
  durationMin: number;
  /** Display-only estimate; the hold returns the real figure. */
  depositCents: number;
  lines: QuoteLine[];
}

function toQuote(
  services: readonly CatalogService[],
  pricing: (service: CatalogService) => { priceCents: number; durationMin: number },
): Quote {
  const lines = services.map((s) => ({ id: s.id, name: s.name, ...pricing(s) }));
  return {
    totalCents: lines.reduce((sum, l) => sum + l.priceCents, 0),
    durationMin: lines.reduce((sum, l) => sum + l.durationMin, 0),
    depositCents: estimateDepositCents(
      services.map((s, i) => ({ ...lines[i], depositPct: s.depositPct })),
    ),
    lines,
  };
}

/** Stylists who offer every selected service. With nothing selected, everyone. */
export function eligibleStaff(
  staff: readonly CatalogStaff[],
  serviceIds: readonly string[],
): CatalogStaff[] {
  return staff.filter((person) => serviceIds.every((id) => id in person.offers));
}

/** The selection at the service's own price and time: what the page showed before stylists existed. */
export function baseQuote(services: readonly CatalogService[]): Quote {
  return toQuote(services, (s) => ({ priceCents: s.priceCents, durationMin: s.durationMin }));
}

/** What this stylist would charge for the selection, or null when they do not offer all of it. */
export function quoteFor(person: CatalogStaff, services: readonly CatalogService[]): Quote | null {
  if (services.some((s) => !(s.id in person.offers))) return null;
  return toQuote(services, (s) => person.offers[s.id]);
}

export interface QuoteRange {
  low: Quote;
  high: Quote;
  /** True when stylists differ in total price or time. */
  differs: boolean;
}

export function quoteRange(
  staff: readonly CatalogStaff[],
  services: readonly CatalogService[],
): QuoteRange | null {
  const quotes = staff.flatMap((person) => quoteFor(person, services) ?? []);
  if (quotes.length === 0) return null;
  const byPrice = [...quotes].sort((a, b) => a.totalCents - b.totalCents);
  const differs = quotes.some(
    (q) => q.totalCents !== quotes[0].totalCents || q.durationMin !== quotes[0].durationMin,
  );
  return { low: byPrice[0], high: byPrice[byPrice.length - 1], differs };
}

/** Lowest and highest price any stylist charges for one service, or null when nobody offers it. */
export function serviceRange(
  staff: readonly CatalogStaff[],
  serviceId: string,
): { minCents: number; maxCents: number } | null {
  const prices = staff.flatMap((p) => p.offers[serviceId]?.priceCents ?? []);
  if (prices.length === 0) return null;
  return { minCents: Math.min(...prices), maxCents: Math.max(...prices) };
}

export interface StaffOption {
  /** Null is "Anyone available". */
  id: string | null;
  name: string;
  quote: Quote;
  /** Show the price on this row: only when stylists differ in price or time. */
  showPrice: boolean;
  /** For "Anyone": the price is the lowest of several, so say "from". */
  fromPrefix: boolean;
}

export const ANYONE_LABEL = "Anyone available";

/** The rows of the stylist step: Anyone first, then each stylist who can do the whole selection. */
export function staffOptions(
  staff: readonly CatalogStaff[],
  services: readonly CatalogService[],
): StaffOption[] {
  const eligible = eligibleStaff(
    staff,
    services.map((s) => s.id),
  ).sort((a, b) => a.name.localeCompare(b.name));
  const range = quoteRange(eligible, services);
  const differs = range?.differs ?? false;

  const anyone: StaffOption = {
    id: null,
    name: ANYONE_LABEL,
    quote: range?.low ?? baseQuote(services),
    showPrice: differs,
    fromPrefix: differs,
  };
  const people = eligible.flatMap((person) => {
    const quote = quoteFor(person, services);
    return quote
      ? [{ id: person.id, name: person.name, quote, showPrice: differs, fromPrefix: false }]
      : [];
  });
  return [anyone, ...people];
}

/**
 * Who a slot is with and what that stylist charges for the selection. Empty when the stylist is not
 * in the catalog's list (choosing is off, or the person is not offered here).
 */
export function slotExtras(
  slot: { staffId?: string },
  staff: readonly CatalogStaff[],
  services: readonly CatalogService[],
): { staffId?: string; priceCents?: number; durationMin?: number } {
  const person = staff.find((p) => p.id === slot.staffId);
  const quote = person ? quoteFor(person, services) : null;
  if (!person || !quote) return {};
  return { staffId: person.id, priceCents: quote.totalCents, durationMin: quote.durationMin };
}

/** One or two initials for the avatar mark. */
export function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  const letters = parts.length === 1 ? [parts[0]] : [parts[0], parts[parts.length - 1]];
  return letters.map((p) => p[0].toUpperCase()).join("");
}
