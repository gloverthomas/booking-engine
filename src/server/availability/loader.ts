import { and, asc, between, eq, inArray, isNull, ne, or, sql } from "drizzle-orm";
import {
  availabilityRule,
  booking,
  rosterException,
  service,
  serviceLevelPrice,
  serviceLocation,
  serviceStaff,
  SLOT_HOLDING_STATUSES,
  staff,
  timeBlock,
} from "@/db/schema";
import type { Db } from "../db-types";
import { priceFor } from "../pricing";
import {
  localDate,
  type Candidate,
  type DayException,
  type Interval,
  type WeeklyRule,
} from "./engine";

export type ServiceRow = typeof service.$inferSelect;

export interface ServiceLine {
  service: ServiceRow;
  durationMin: number;
  priceCents: number;
}

/** What one staff member would do for the selected services (per-staff and per-level pricing applied). */
export interface StaffPlan {
  staffId: string;
  /** Seniority tier that selected the level prices. */
  level: number;
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

/**
 * Active staff who offer ALL the services (optionally restricted to one), with per-staff totals.
 * Every price and duration goes through priceFor: the stylist's own override, then the price for
 * their level (service_level_price), then the service default.
 */
export async function loadStaffPlans(
  db: Db,
  services: ServiceRow[],
  staffId?: string,
): Promise<StaffPlan[]> {
  const rows = await db
    .select({
      staffId: serviceStaff.staffId,
      level: staff.level,
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
  if (rows.length === 0) return [];

  const levelRows = await db
    .select()
    .from(serviceLevelPrice)
    .where(
      and(
        inArray(
          serviceLevelPrice.serviceId,
          services.map((s) => s.id),
        ),
        inArray(serviceLevelPrice.level, [...new Set(rows.map((row) => row.level))]),
      ),
    );
  const levelPrices = new Map(levelRows.map((row) => [`${row.serviceId}:${row.level}`, row]));

  const byStaff = new Map<string, typeof rows>();
  for (const row of rows) byStaff.set(row.staffId, [...(byStaff.get(row.staffId) ?? []), row]);

  const plans: StaffPlan[] = [];
  for (const [id, offers] of byStaff) {
    const overrides = new Map(offers.map((o) => [o.serviceId, o]));
    if (services.some((s) => !overrides.has(s.id))) continue;
    const level = offers[0].level;
    const lines = services.map((svc) => {
      const pricing = priceFor(svc, overrides.get(svc.id), levelPrices.get(`${svc.id}:${level}`));
      return { service: svc, ...pricing };
    });
    plans.push({
      staffId: id,
      level,
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

/**
 * Roster exceptions that matter for a search at `locationId`: that location's, plus those with no
 * location (they apply everywhere). Dates are local YYYY-MM-DD, inclusive.
 */
export async function loadExceptions(
  db: Db,
  locationId: string,
  staffIds: string[],
  fromDate: string,
  toDate: string,
): Promise<Map<string, DayException[]>> {
  const rows = await db
    .select()
    .from(rosterException)
    .where(
      and(
        inArray(rosterException.staffId, staffIds),
        between(rosterException.date, fromDate, toDate),
        or(isNull(rosterException.locationId), eq(rosterException.locationId, locationId)),
      ),
    );
  const byStaff = new Map<string, DayException[]>();
  for (const row of rows) {
    byStaff.set(row.staffId, [
      ...(byStaff.get(row.staffId) ?? []),
      {
        date: row.date,
        kind: row.kind,
        startMinute: row.startMinute,
        endMinute: row.endMinute,
      },
    ]);
  }
  return byStaff;
}

function rangeOverlap(column: typeof booking.during | typeof timeBlock.during, window: Interval) {
  return sql`${column} && tstzrange(${window.start.toISOString()}::timestamptz, ${window.end.toISOString()}::timestamptz, '[)')`;
}

function isLapsedHold(row: { status: string; holdExpiresAt: Date | null }, now: Date): boolean {
  return (
    row.status === "pending_payment" &&
    row.holdExpiresAt !== null &&
    row.holdExpiresAt.getTime() <= now.getTime()
  );
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

  const bookings = await loadHoldingBookings(db, staffIds, window, excludeBookingId);
  for (const row of bookings) {
    if (!isLapsedHold(row, now)) add(row.staffId, row.during);
  }
  return busy;
}

async function loadHoldingBookings(
  db: Db,
  staffIds: string[],
  window: Interval,
  excludeBookingId?: string,
) {
  return db
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
}

/** How many live bookings each stylist has per local date in `window` (balances "first available"). */
export async function loadDayLoads(
  db: Db,
  staffIds: string[],
  window: Interval,
  now: Date,
  timezone: string,
  excludeBookingId?: string,
): Promise<Map<string, Map<string, number>>> {
  const rows = await loadHoldingBookings(db, staffIds, window, excludeBookingId);
  const loads = new Map<string, Map<string, number>>();
  for (const row of rows) {
    if (isLapsedHold(row, now)) continue;
    const date = localDate(row.during.start, timezone);
    const days = loads.get(row.staffId) ?? new Map<string, number>();
    days.set(date, (days.get(date) ?? 0) + 1);
    loads.set(row.staffId, days);
  }
  return loads;
}

export function toCandidates(
  plans: StaffPlan[],
  rules: Map<string, WeeklyRule[]>,
  busy: Map<string, Interval[]>,
  exceptions: Map<string, DayException[]> = new Map(),
): Candidate[] {
  return plans.map((plan) => ({
    staffId: plan.staffId,
    durationMin: plan.durationMin,
    bufferMin: plan.bufferMin,
    rules: rules.get(plan.staffId) ?? [],
    exceptions: exceptions.get(plan.staffId) ?? [],
    busy: busy.get(plan.staffId) ?? [],
  }));
}
