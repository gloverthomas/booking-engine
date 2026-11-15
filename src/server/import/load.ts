import { and, inArray, isNotNull, sql } from "drizzle-orm";
import { booking, business, client, location, service, staff } from "@/db/schema";
import type { Db } from "../db-types";
import { systemClock, type Clock } from "../clock";
import type { Catalog } from "./types";

const HOLDING = ["pending_payment", "confirmed"] as const;

/** Everything the planner needs, read once. Small tables, so plain selects are fine. */
export async function loadCatalog(db: Db, clock: Clock = systemClock): Promise<Catalog> {
  const [biz] = await db
    .select({ id: business.id, timezone: business.timezone })
    .from(business)
    .limit(1);
  const [locations, people, services, clients, refs, held] = await Promise.all([
    db.select({ id: location.id, name: location.name }).from(location),
    db.select({ id: staff.id, name: staff.name }).from(staff),
    db
      .select({
        id: service.id,
        name: service.name,
        durationMin: service.durationMin,
        priceCents: service.priceCents,
      })
      .from(service),
    db
      .select({
        id: client.id,
        firstName: client.firstName,
        lastName: client.lastName,
        email: client.email,
        phone: client.phone,
        externalRef: client.externalRef,
      })
      .from(client)
      .where(sql`${client.mergedIntoId} IS NULL`),
    db.select({ ref: booking.externalRef }).from(booking).where(isNotNull(booking.externalRef)),
    db
      .select({ staffId: booking.staffId, during: booking.during })
      .from(booking)
      .where(and(inArray(booking.status, [...HOLDING]))),
  ]);

  return {
    businessId: biz?.id,
    zone: biz?.timezone ?? "Australia/Melbourne",
    now: clock(),
    locations,
    staff: people,
    services,
    clients,
    bookingRefs: new Set(refs.flatMap((r) => (r.ref ? [r.ref] : []))),
    heldBookings: held.map((h) => ({
      staffId: h.staffId,
      start: h.during.start,
      end: h.during.end,
    })),
  };
}
