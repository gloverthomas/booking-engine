import { and, asc, ilike, inArray, or, sql, type AnyColumn, type SQL } from "drizzle-orm";
import { bookingService, business, client, staff } from "@/db/schema";
import { formatRange, type TimeRange } from "@/db/tstzrange";
import { parseSettings, type BusinessSettings } from "../settings";
import type { Db } from "../db-types";
import { assignStaffColours, UNKNOWN_STAFF_COLOUR } from "./staff-colour";

export function fullName(firstName: string, lastName: string): string {
  return `${firstName} ${lastName}`.trim();
}

/** Escape % _ and \ so user text is matched literally inside ILIKE. */
export function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/** SQL predicate: the range column overlaps [from, to). */
export function overlaps(column: AnyColumn, range: TimeRange): SQL {
  return sql`${column} && ${formatRange(range)}::tstzrange`;
}

export function lowerOf(column: AnyColumn): SQL<string> {
  return sql<string>`lower(${column})`;
}

export interface PaymentLike {
  kind: string;
  status: string;
  amountCents: number;
}

const COUNTED_STATUSES = new Set(["succeeded", "partially_refunded", "refunded"]);

/**
 * Net money received for a booking: every non-refund payment that actually settled, minus refund rows.
 * A payment's own status flips to refunded when refunded, so refund rows are the single source for what
 * went back out.
 */
export function netPaidCents(payments: readonly PaymentLike[]): number {
  let total = 0;
  for (const p of payments) {
    if (!COUNTED_STATUSES.has(p.status)) continue;
    total += p.kind === "refund" ? -p.amountCents : p.amountCents;
  }
  return Math.max(0, total);
}

export interface BusinessContext {
  businessId: string;
  timezone: string;
  settings: BusinessSettings;
}

/** Single-tenant: the one business row. */
export async function getBusinessContext(db: Db): Promise<BusinessContext> {
  const [row] = await db.select().from(business).limit(1);
  if (!row) throw new Error("No business has been set up yet");
  return { businessId: row.id, timezone: row.timezone, settings: parseSettings(row.settings) };
}

export interface StaffEntry {
  id: string;
  name: string;
  colour: string;
  active: boolean;
}

/**
 * Every stylist (active or not) with a resolved calendar colour. Ordered by creation so the palette
 * fallback is stable. One small query; the team is a handful of people.
 */
export async function loadStaffDirectory(db: Db): Promise<StaffEntry[]> {
  const rows = await db
    .select({ id: staff.id, name: staff.name, colour: staff.colour, active: staff.active })
    .from(staff)
    .orderBy(asc(staff.createdAt), asc(staff.name), asc(staff.id));
  const colours = assignStaffColours(rows);
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    active: r.active,
    colour: colours.get(r.id) ?? UNKNOWN_STAFF_COLOUR,
  }));
}

export function staffById(directory: readonly StaffEntry[]): Map<string, StaffEntry> {
  return new Map(directory.map((s) => [s.id, s]));
}

export function upperOf(column: AnyColumn): SQL<string> {
  return sql<string>`upper(${column})`;
}

/** Service names per booking, in the order they were booked. */
export async function loadServiceNames(
  db: Db,
  bookingIds: readonly string[],
): Promise<Map<string, string[]>> {
  const names = new Map<string, string[]>();
  if (bookingIds.length === 0) return names;
  const rows = await db
    .select({ bookingId: bookingService.bookingId, name: bookingService.name })
    .from(bookingService)
    .where(inArray(bookingService.bookingId, [...bookingIds]))
    .orderBy(asc(bookingService.position));
  for (const row of rows) {
    names.set(row.bookingId, [...(names.get(row.bookingId) ?? []), row.name]);
  }
  return names;
}

/**
 * Free-text client search over the client table. A query made only of digits and phone punctuation matches
 * the stored E.164 phone (so "0411 222 333" finds +61411222333); anything else must match every word against
 * first name, last name, email or phone.
 */
export function clientMatches(query: string): SQL | undefined {
  const text = query.trim();
  if (!text) return undefined;

  if (/^[\d\s()+-]+$/.test(text)) {
    const digits = text.replace(/\D/g, "").replace(/^0+/, "");
    return digits ? ilike(client.phone, `%${digits}%`) : undefined;
  }

  const words = text.split(/\s+/).map((w) => `%${escapeLike(w)}%`);
  return and(
    ...words.map((pattern) =>
      or(
        ilike(client.firstName, pattern),
        ilike(client.lastName, pattern),
        ilike(client.email, pattern),
        ilike(client.phone, pattern),
      ),
    ),
  );
}
