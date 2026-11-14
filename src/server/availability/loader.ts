import { and, asc, eq, inArray, ne, sql } from "drizzle-orm";
import {
  availabilityRule,
  booking,
  service,
  serviceLocation,
  serviceStaff,
  SLOT_HOLDING_STATUSES,
  staff,
  timeBlock,
} from "@/db/schema";
import type { Db } from "../db-types";
import { priceFor } from "../pricing";
import type { Candidate, Interval, WeeklyRule } from "./engine";

export type ServiceRow = typeof service.$inferSelect;

export interface ServiceLine {
  service: ServiceRow;
  durationMin: number;
  priceCents: number;
}

/** What one staff member would do for the selected services (per-staff overrides applied). */
export interface StaffPlan {
  staffId: string;
  lines: ServiceLine[];
  durationMin: number;
  bufferMin: number;
  totalCents: number;
}

export type ServiceResolution =
  { ok: true; services: ServiceRow[] } | { ok: false; reason: string };

/** Selected services in request order, de-duplicated. Every one must be active and offered at the location. */
export async function resolveServices(
  db: Db,
  locationId: string,
  serviceIds: string[],
): Promise<ServiceResolution> {
  const ids = [...new Set(serviceIds)];
  if (ids.length === 0) return { ok: false, reason: "No services selected" };

  const rows = await db.select().from(service).where(inArray(service.id, ids));
  const byId = new Map(rows.map((row) => [row.id, row]));
  const offered = await db
    .select({ serviceId: serviceLocation.serviceId })
    .from(serviceLocation)
    .where(
      and(eq(serviceLocation.locationId, locationId), inArray(serviceLocation.serviceId, ids)),
    );
  const offeredHere = new Set(offered.map((row) => row.serviceId));

  const ordered: ServiceRow[] = [];
  for (const id of ids) {
    const row = byId.get(id);
    if (!row) return { ok: false, reason: `Unknown service: ${id}` };
    if (!row.active) return { ok: false, reason: `Service is not available: ${row.name}` };
    if (!offeredHere.has(id)) {
      return { ok: false, reason: `Service is not offered at this location: ${row.name}` };
    }
    ordered.push(row);
  }
  return { ok: true, services: ordered };
}

/** Active staff who offer ALL the services (optionally restricted to one), with per-staff totals. */
export async function loadStaffPlans(
  db: Db,
  services: ServiceRow[],
  staffId?: string,
): Promise<StaffPlan[]> {
  const rows = await db
    .select({
      staffId: serviceStaff.staffId,
      serviceId: serviceStaff.serviceId,
      priceCents: serviceStaff.priceCents,
      durationMin: serviceStaff.durationMin,
    })
    .from(serviceStaff)
    .innerJoin(staff, eq(staff.id, serviceStaff.staffId))
    .where(
      and(
        inArray(
          serviceStaff.serviceId,
          services.map((s) => s.id),
        ),
        eq(staff.active, true),
        staffId ? eq(staff.id, staffId) : undefined,
      ),
    )
    .orderBy(asc(staff.name), asc(staff.id));

  const byStaff = new Map<string, typeof rows>();
  for (const row of rows) byStaff.set(row.staffId, [...(byStaff.get(row.staffId) ?? []), row]);

  const plans: StaffPlan[] = [];
  for (const [id, offers] of byStaff) {
    const overrides = new Map(offers.map((o) => [o.serviceId, o]));
    if (services.some((s) => !overrides.has(s.id))) continue;
    const lines = services.map((svc) => {
      const pricing = priceFor(svc, overrides.get(svc.id));
      return { service: svc, ...pricing };
    });
    plans.push({
      staffId: id,
      lines,
      durationMin: lines.reduce((sum, l) => sum + l.durationMin, 0),
      bufferMin: services[services.length - 1].bufferMin,
      totalCents: lines.reduce((sum, l) => sum + l.priceCents, 0),
    });
  }
  return plans;
}

export async function loadRules(
  db: Db,
  locationId: string,
  staffIds: string[],
): Promise<Map<string, WeeklyRule[]>> {
  const rows = await db
    .select()
    .from(availabilityRule)
    .where(
      and(eq(availabilityRule.locationId, locationId), inArray(availabilityRule.staffId, staffIds)),
    );
  const rules = new Map<string, WeeklyRule[]>();
  for (const row of rows) {
    rules.set(row.staffId, [
      ...(rules.get(row.staffId) ?? []),
      {
        weekday: row.weekday,
        startMinute: row.startMinute,
        endMinute: row.endMinute,
        validFrom: row.validFrom,
        validTo: row.validTo,
      },
    ]);
  }
  return rules;
}

function rangeOverlap(column: typeof booking.during | typeof timeBlock.during, window: Interval) {
  return sql`${column} && tstzrange(${window.start.toISOString()}::timestamptz, ${window.end.toISOString()}::timestamptz, '[)')`;
}

/**
 * Everything that occupies each staff member in `window`: time blocks plus pending (live hold) and
 * confirmed bookings. `excludeBookingId` lets a booking be moved without colliding with itself.
 */
export async function loadBusy(
  db: Db,
  staffIds: string[],
  window: Interval,
  now: Date,
  excludeBookingId?: string,
): Promise<Map<string, Interval[]>> {
  const busy = new Map<string, Interval[]>();
  const add = (staffId: string, interval: Interval) =>
    busy.set(staffId, [...(busy.get(staffId) ?? []), interval]);

  const blocks = await db
    .select({ staffId: timeBlock.staffId, during: timeBlock.during })
    .from(timeBlock)
    .where(and(inArray(timeBlock.staffId, staffIds), rangeOverlap(timeBlock.during, window)));
  for (const block of blocks) add(block.staffId, block.during);

  const bookings = await db
    .select({
      staffId: booking.staffId,
      during: booking.during,
      status: booking.status,
      holdExpiresAt: booking.holdExpiresAt,
    })
    .from(booking)
    .where(
      and(
        inArray(booking.staffId, staffIds),
        inArray(booking.status, [...SLOT_HOLDING_STATUSES]),
        excludeBookingId ? ne(booking.id, excludeBookingId) : undefined,
        rangeOverlap(booking.during, window),
      ),
    );
  for (const row of bookings) {
    const lapsed =
      row.status === "pending_payment" &&
      row.holdExpiresAt !== null &&
      row.holdExpiresAt.getTime() <= now.getTime();
    if (!lapsed) add(row.staffId, row.during);
  }
  return busy;
}

export function toCandidates(
  plans: StaffPlan[],
  rules: Map<string, WeeklyRule[]>,
  busy: Map<string, Interval[]>,
): Candidate[] {
  return plans.map((plan) => ({
    staffId: plan.staffId,
    durationMin: plan.durationMin,
    bufferMin: plan.bufferMin,
    rules: rules.get(plan.staffId) ?? [],
    busy: busy.get(plan.staffId) ?? [],
  }));
}
