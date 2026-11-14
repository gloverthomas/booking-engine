import { asc, eq } from "drizzle-orm";
import { booking, bookingService, location } from "@/db/schema";
import type { PublicBookingSummary } from "../contracts";
import type { Db } from "../db-types";
import { verifyManageToken } from "../manage-token";
import { isUuid, resolveEncryptionKey, type BookingOptions } from "./shared";

const MINUTE_MS = 60_000;

/**
 * Lookup for the public manage-booking page. Returns null for an unknown or invalid token.
 * `end` is the appointment end as the client sees it (the service buffer is not included).
 */
export async function getBookingByToken(
  db: Db,
  rawToken: string,
  options: BookingOptions = {},
): Promise<PublicBookingSummary | null> {
  const bookingId = verifyManageToken(rawToken, resolveEncryptionKey(options));
  if (!bookingId || !isUuid(bookingId)) return null;

  const [row] = await db
    .select({ booking, locationName: location.name })
    .from(booking)
    .innerJoin(location, eq(location.id, booking.locationId))
    .where(eq(booking.id, bookingId));
  if (!row) return null;

  const lines = await db
    .select()
    .from(bookingService)
    .where(eq(bookingService.bookingId, bookingId))
    .orderBy(asc(bookingService.position));
  const durationMin = lines.reduce((sum, line) => sum + line.durationMin, 0);
  const { start, end } = row.booking.during;

  return {
    bookingId,
    status: row.booking.status,
    start,
    end: lines.length > 0 ? new Date(start.getTime() + durationMin * MINUTE_MS) : end,
    locationName: row.locationName,
    services: lines.map((line) => ({ name: line.name, priceCents: line.priceCents })),
    totalCents: row.booking.totalCents,
    depositCents: row.booking.depositCents,
  };
}
