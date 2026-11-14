import { asc, eq } from "drizzle-orm";
import { booking, bookingService, client, location } from "@/db/schema";
import type { Db } from "@/server/db-types";

export type BookingRow = typeof booking.$inferSelect;
export type ClientRow = typeof client.$inferSelect;
export type LocationRow = typeof location.$inferSelect;
export type BookingServiceRow = typeof bookingService.$inferSelect;

export interface BookingBundle {
  booking: BookingRow;
  client: ClientRow;
  location: LocationRow;
  services: BookingServiceRow[];
}

/** Statuses for which the appointment still stands (and therefore has a calendar event / invoice). */
export const LIVE_STATUSES: ReadonlyArray<BookingRow["status"]> = ["confirmed", "completed"];

export async function loadBookingBundle(db: Db, bookingId: string): Promise<BookingBundle | null> {
  const [row] = await db
    .select({ booking, client, location })
    .from(booking)
    .innerJoin(client, eq(client.id, booking.clientId))
    .innerJoin(location, eq(location.id, booking.locationId))
    .where(eq(booking.id, bookingId));
  if (!row) return null;
  const services = await db
    .select()
    .from(bookingService)
    .where(eq(bookingService.bookingId, bookingId))
    .orderBy(asc(bookingService.position));
  return { ...row, services };
}

export function clientFullName(c: Pick<ClientRow, "firstName" | "lastName">): string {
  return `${c.firstName} ${c.lastName}`.trim();
}
