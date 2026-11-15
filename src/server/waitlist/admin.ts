import { asc, desc, eq, inArray } from "drizzle-orm";
import { DateTime } from "luxon";
import { client, location, service, staff, waitlistEntry, waitlistOffer } from "@/db/schema";
import { getBusinessContext } from "../availability/context";
import { getAvailableSlots } from "../availability";
import { loadStaffPlans, resolveServices } from "../availability/loader";
import { NotFoundError } from "../booking/errors";
import { isUuid } from "../booking/shared";
import type { Db } from "../db-types";
import type { EntryRow, OfferRow } from "./shared";
import { windowAcceptsStart } from "./window";

export type WaitlistView = "active" | "history";

export interface AdminOfferRow {
  id: string;
  status: OfferRow["status"];
  start: Date;
  end: Date;
  staffName: string;
  offeredBy: string;
  expiresAt: Date;
}

export interface AdminEntryRow {
  id: string;
  status: EntryRow["status"];
  clientId: string;
  clientName: string;
  clientPhone: string | null;
  clientEmail: string | null;
  locationName: string;
  staffName: string | null;
  serviceNames: string[];
  earliestDate: string;
  latestDate: string;
  weekdays: number[] | null;
  fromMinute: number | null;
  toMinute: number | null;
  notes: string | null;
  createdAt: Date;
  offers: AdminOfferRow[];
}

const ACTIVE = ["waiting", "offered"] as const;
const HISTORY = ["booked", "expired", "cancelled"] as const;

/** Entries for the admin list, newest history last, oldest waiting first, with their offers. */
export async function listWaitlist(
  db: Db,
  view: WaitlistView | { entryId: string },
  limit = 200,
): Promise<AdminEntryRow[]> {
  const filter =
    typeof view === "object"
      ? eq(waitlistEntry.id, view.entryId)
      : inArray(waitlistEntry.status, view === "active" ? [...ACTIVE] : [...HISTORY]);
  const rows = await db
    .select({ entry: waitlistEntry, client, locationName: location.name, staffName: staff.name })
    .from(waitlistEntry)
    .innerJoin(client, eq(client.id, waitlistEntry.clientId))
    .innerJoin(location, eq(location.id, waitlistEntry.locationId))
    .leftJoin(staff, eq(staff.id, waitlistEntry.staffId))
    .where(filter)
    .orderBy(view === "history" ? desc(waitlistEntry.updatedAt) : asc(waitlistEntry.createdAt))
    .limit(limit);
  if (rows.length === 0) return [];

  const serviceIds = [...new Set(rows.flatMap((r) => r.entry.serviceIds))];
  const services = await db
    .select({ id: service.id, name: service.name })
    .from(service)
    .where(inArray(service.id, serviceIds));
  const serviceName = new Map(services.map((s) => [s.id, s.name]));

  const offers = await db
    .select({ offer: waitlistOffer, staffName: staff.name })
    .from(waitlistOffer)
    .innerJoin(staff, eq(staff.id, waitlistOffer.staffId))
    .where(
      inArray(
        waitlistOffer.entryId,
        rows.map((r) => r.entry.id),
      ),
    )
    .orderBy(desc(waitlistOffer.createdAt));
  const offersByEntry = new Map<string, AdminOfferRow[]>();
  for (const { offer, staffName } of offers) {
    const list = offersByEntry.get(offer.entryId) ?? [];
    list.push({
      id: offer.id,
      status: offer.status,
      start: offer.during.start,
      end: offer.during.end,
      staffName,
      offeredBy: offer.offeredBy,
      expiresAt: offer.expiresAt,
    });
    offersByEntry.set(offer.entryId, list);
  }

  return rows.map(({ entry, client: c, locationName, staffName }) => ({
    id: entry.id,
    status: entry.status,
    clientId: c.id,
    clientName: `${c.firstName} ${c.lastName}`.trim(),
    clientPhone: c.phone,
    clientEmail: c.email,
    locationName,
    staffName,
    serviceNames: entry.serviceIds.map((id) => serviceName.get(id) ?? "Service"),
    earliestDate: entry.earliestDate,
    latestDate: entry.latestDate,
    weekdays: entry.weekdays,
    fromMinute: entry.fromMinute,
    toMinute: entry.toMinute,
    notes: entry.notes,
    createdAt: entry.createdAt,
    offers: offersByEntry.get(entry.id) ?? [],
  }));
}

export interface OfferableSlot {
  staffId: string;
  staffName: string;
  start: Date;
  end: Date;
}

export interface OfferableSlots {
  entry: AdminEntryRow;
  timezone: string;
  slots: OfferableSlot[];
}

const LOOKAHEAD_DAYS = 21;
const MAX_SLOTS = 60;

/**
 * Open slots that suit an entry (its stylist or anyone offering all its services, inside its date,
 * weekday and time window), soonest first, for the owner to offer by hand.
 */
export async function listOfferableSlots(
  db: Db,
  entryId: string,
  now: Date = new Date(),
): Promise<OfferableSlots> {
  if (!isUuid(entryId)) throw new NotFoundError(`Waitlist entry not found: ${entryId}`);
  const [entry] = await db.select().from(waitlistEntry).where(eq(waitlistEntry.id, entryId));
  if (!entry) throw new NotFoundError(`Waitlist entry not found: ${entryId}`);
  const [summary] = await listWaitlist(db, { entryId });
  if (!summary) throw new NotFoundError(`Waitlist entry not found: ${entryId}`);

  const context = await getBusinessContext(db, entry.locationId);
  const today = DateTime.fromJSDate(now, { zone: context.timezone }).toISODate() as string;
  const from = entry.earliestDate > today ? entry.earliestDate : today;
  const horizon = DateTime.fromISO(from, { zone: context.timezone })
    .plus({ days: LOOKAHEAD_DAYS })
    .toISODate() as string;
  const to = entry.latestDate < horizon ? entry.latestDate : horizon;
  if (from > to) return { entry: summary, timezone: context.timezone, slots: [] };

  const resolution = await resolveServices(db, entry.locationId, entry.serviceIds);
  if (!resolution.ok) return { entry: summary, timezone: context.timezone, slots: [] };
  const plans = await loadStaffPlans(db, resolution.services, entry.staffId ?? undefined);
  const names = new Map(
    (
      await db
        .select({ id: staff.id, name: staff.name })
        .from(staff)
        .where(
          inArray(
            staff.id,
            plans.map((p) => p.staffId),
          ),
        )
    ).map((s) => [s.id, s.name]),
  );

  const slots: OfferableSlot[] = [];
  for (const plan of plans) {
    const open = await getAvailableSlots(db, {
      locationId: entry.locationId,
      staffId: plan.staffId,
      serviceIds: entry.serviceIds,
      fromDate: from,
      toDate: to,
      now,
    });
    for (const slot of open) {
      if (!windowAcceptsStart(entry, slot.start, context.timezone)) continue;
      slots.push({
        staffId: plan.staffId,
        staffName: names.get(plan.staffId) ?? "",
        start: slot.start,
        end: slot.end,
      });
    }
  }
  slots.sort(
    (a, b) => a.start.getTime() - b.start.getTime() || a.staffName.localeCompare(b.staffName),
  );
  return { entry: summary, timezone: context.timezone, slots: slots.slice(0, MAX_SLOTS) };
}
