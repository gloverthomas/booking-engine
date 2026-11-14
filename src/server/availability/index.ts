import { DateTime } from "luxon";
import { z } from "zod";
import type { AvailabilityQuery, AvailableSlot } from "../contracts";
import type { Db } from "../db-types";
import { ValidationError } from "../booking/errors";
import { getBusinessContext, type BusinessContext } from "./context";
import { computeSlots } from "./engine";
import {
  loadBusy,
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

export interface SlotWithPlan extends AvailableSlot {
  /** End of the time the stylist is occupied (appointment plus buffer). */
  occupiedEnd: Date;
}

export interface AvailabilitySearch {
  context: BusinessContext;
  /** Every (staff, start) pair, ordered by start then staff. Not de-duplicated. */
  slots: SlotWithPlan[];
  plans: Map<string, StaffPlan>;
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
  const empty: AvailabilitySearch = { context, slots: [], plans: new Map() };
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

  const now = query.now ?? new Date();
  const staffIds = plans.map((p) => p.staffId);
  const window = {
    start: from.startOf("day").toJSDate(),
    // Extra day: an occupied span (appointment + buffer) can run past local midnight.
    end: to.startOf("day").plus({ days: 2 }).toJSDate(),
  };
  const [rules, busy] = await Promise.all([
    loadRules(db, locationId, staffIds),
    loadBusy(db, staffIds, window, now, options.excludeBookingId),
  ]);

  const raw = computeSlots({
    timezone: zone,
    fromDate,
    toDate,
    now,
    slotStepMin: context.settings.slotStepMin,
    minNoticeMin: context.settings.minNoticeMin,
    maxAdvanceDays: context.settings.maxAdvanceDays,
    candidates: toCandidates(plans, rules, busy),
  });

  return {
    context,
    plans: new Map(plans.map((p) => [p.staffId, p])),
    slots: raw.map((slot) => ({
      staffId: slot.staffId,
      start: slot.start,
      end: slot.end,
      occupiedEnd: slot.occupiedEnd,
    })),
  };
}

/**
 * Bookable start times for a location over a local date range.
 * With no staffId ("first available") each start time appears once, assigned to the first staff
 * member (alphabetical) who can do all selected services at that time.
 */
export async function getAvailableSlots(
  db: Db,
  query: AvailabilityQuery,
): Promise<AvailableSlot[]> {
  const { slots } = await searchAvailability(db, query);
  const publicSlots = slots.map(({ staffId, start, end }) => ({ staffId, start, end }));
  if (query.staffId) return publicSlots;

  const seen = new Set<number>();
  return publicSlots.filter((slot) => {
    const key = slot.start.getTime();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
