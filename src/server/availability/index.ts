import { DateTime } from "luxon";
import { z } from "zod";
import type { AvailabilityQuery, AvailableSlot } from "../contracts";
import type { Db } from "../db-types";
import { ValidationError } from "../booking/errors";
import { getBusinessContext, type BusinessContext } from "./context";
import { computeSlots, localDate } from "./engine";
import {
  loadBusy,
  loadDayLoads,
  loadExceptions,
  loadRules,
  loadStaffPlans,
  resolveServices,
  toCandidates,
  type StaffPlan,
} from "./loader";

const MAX_RANGE_DAYS = 366;

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Dates must be YYYY-MM-DD")
  .refine((value) => DateTime.fromISO(value).isValid, "Not a real calendar date");

const queryInput = z.object({
  locationId: z.uuid(),
  staffId: z.uuid().optional(),
  serviceIds: z.array(z.uuid()).min(1, "Select at least one service"),
  fromDate: isoDate,
  toDate: isoDate,
});

/**
 * A slot priced for the stylist who would do it. The extra fields mean callers that only know
 * AvailableSlot keep working; "first available" returns the assigned stylist's own price and length.
 */
export interface PricedSlot extends AvailableSlot {
  /** Total for all selected services at this stylist's price (own or level pricing applied). */
  totalCents: number;
  /** Total length of the selected services for this stylist, in minutes (excludes the buffer). */
  durationMin: number;
}

export interface SlotWithPlan extends PricedSlot {
  /** End of the time the stylist is occupied (appointment plus buffer). */
  occupiedEnd: Date;
}

export interface AvailabilitySearch {
  context: BusinessContext;
  /** Every (staff, start) pair, ordered by start then staff. Not de-duplicated. */
  slots: SlotWithPlan[];
  plans: Map<string, StaffPlan>;
  /** Live bookings per stylist per local date (YYYY-MM-DD), used to balance "first available". */
  dayLoads: Map<string, Map<string, number>>;
}

/**
 * Internal search used by getAvailableSlots and by the booking lifecycle (which needs the per-staff
 * plan and the occupied end). `excludeBookingId` lets an existing booking be moved onto its own time.
 */
export async function searchAvailability(
  db: Db,
  query: AvailabilityQuery,
  options: { excludeBookingId?: string } = {},
): Promise<AvailabilitySearch> {
  const parsed = queryInput.safeParse(query);
  if (!parsed.success) {
    throw new ValidationError(
      "Invalid availability query",
      parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
    );
  }
  const { locationId, staffId, serviceIds, fromDate, toDate } = parsed.data;
  if (fromDate > toDate) throw new ValidationError("fromDate must not be after toDate");

  const context = await getBusinessContext(db, locationId);
  const empty: AvailabilitySearch = {
    context,
    slots: [],
    plans: new Map(),
    dayLoads: new Map(),
  };
  if (!context.locationActive) return empty;

  const zone = context.timezone;
  const from = DateTime.fromISO(fromDate, { zone });
  const to = DateTime.fromISO(toDate, { zone });
  if (to.diff(from, "days").days > MAX_RANGE_DAYS) {
    throw new ValidationError(`Date range is limited to ${MAX_RANGE_DAYS} days`);
  }

  const resolution = await resolveServices(db, locationId, serviceIds);
  if (!resolution.ok) return empty;

  const plans = await loadStaffPlans(db, resolution.services, staffId);
  if (plans.length === 0) return empty;
  const planByStaff = new Map(plans.map((p) => [p.staffId, p]));

  const now = query.now ?? new Date();
  const staffIds = plans.map((p) => p.staffId);
  const window = {
    start: from.startOf("day").toJSDate(),
    // Extra day: an occupied span (appointment + buffer) can run past local midnight.
    end: to.startOf("day").plus({ days: 2 }).toJSDate(),
  };
  const [rules, exceptions, busy, dayLoads] = await Promise.all([
    loadRules(db, locationId, staffIds),
    loadExceptions(db, locationId, staffIds, fromDate, toDate),
    loadBusy(db, staffIds, window, now, options.excludeBookingId),
    loadDayLoads(db, staffIds, window, now, zone, options.excludeBookingId),
  ]);

  const raw = computeSlots({
    timezone: zone,
    fromDate,
    toDate,
    now,
    slotStepMin: context.settings.slotStepMin,
    minNoticeMin: context.settings.minNoticeMin,
    maxAdvanceDays: context.settings.maxAdvanceDays,
    candidates: toCandidates(plans, rules, busy, exceptions),
  });

  return {
    context,
    plans: planByStaff,
    dayLoads,
    slots: raw.flatMap((slot) => {
      const plan = planByStaff.get(slot.staffId);
      if (!plan) return [];
      return [
        {
          staffId: slot.staffId,
          start: slot.start,
          end: slot.end,
          occupiedEnd: slot.occupiedEnd,
          totalCents: plan.totalCents,
          durationMin: plan.durationMin,
        },
      ];
    }),
  };
}

/**
 * "First available": keep ONE stylist per start time, the one with the fewest bookings that local
 * day among those free at that time. Ties keep the engine's order (alphabetical by name).
 */
export function assignFirstAvailable(search: AvailabilitySearch): SlotWithPlan[] {
  const loadOf = (slot: SlotWithPlan): number =>
    search.dayLoads.get(slot.staffId)?.get(localDate(slot.start, search.context.timezone)) ?? 0;

  const best = new Map<number, SlotWithPlan>();
  for (const slot of search.slots) {
    const key = slot.start.getTime();
    const current = best.get(key);
    if (!current || loadOf(slot) < loadOf(current)) best.set(key, slot);
  }
  return search.slots.filter((slot) => best.get(slot.start.getTime()) === slot);
}

/** The slot starting exactly at `start`: the requested stylist's, or the first-available pick. */
export function pickSlot(
  search: AvailabilitySearch,
  start: Date,
  staffId?: string,
): SlotWithPlan | undefined {
  const pool = staffId ? search.slots : assignFirstAvailable(search);
  return pool.find(
    (slot) =>
      slot.start.getTime() === start.getTime() &&
      (staffId === undefined || slot.staffId === staffId),
  );
}

/**
 * Bookable start times for a location over a local date range, each priced for its stylist.
 * With no staffId ("first available") each start time appears once, assigned to the free stylist with
 * the fewest bookings that day (ties: alphabetical), carrying that stylist's own price and length.
 */
export async function getAvailableSlots(
  db: Db,
  query: AvailabilityQuery,
  options: { excludeBookingId?: string } = {},
): Promise<PricedSlot[]> {
  const search = await searchAvailability(db, query, options);
  const chosen = query.staffId ? search.slots : assignFirstAvailable(search);
  return chosen.map(({ staffId, start, end, totalCents, durationMin }) => ({
    staffId,
    start,
    end,
    totalCents,
    durationMin,
  }));
}
