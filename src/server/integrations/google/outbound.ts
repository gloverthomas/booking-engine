import { eq } from "drizzle-orm";
import { booking } from "@/db/schema";
import { recordSuccess } from "../common/account-store";
import { LIVE_STATUSES, loadBookingBundle, type BookingBundle } from "../common/booking-data";
import { requireAppUrl } from "../common/env";
import {
  AuthRevokedError,
  ProviderConflictError,
  ProviderGoneError,
  ProviderNotFoundError,
} from "../common/errors";
import { buildBookingEvent, deterministicEventId } from "./event-mapper";
import {
  loadAllGoogleRuntimes,
  pickOutboundRuntime,
  reportGoogleFailure,
  type GoogleDeps,
  type GoogleRuntime,
} from "./runtime";

/** Shape of what the relay publishes: `{ eventId, type, ...payload }`. */
export interface IncomingDomainEvent {
  eventId?: string;
  type: string;
  bookingId?: string;
}

const HANDLED = new Set([
  "booking.confirmed",
  "booking.rescheduled",
  "booking.cancelled",
  "booking.no_show",
]);

const isMissing = (error: unknown): boolean =>
  error instanceof ProviderNotFoundError || error instanceof ProviderGoneError;

async function saveEventId(deps: GoogleDeps, bookingId: string, eventId: string | null) {
  await deps.db.update(booking).set({ gcalEventId: eventId }).where(eq(booking.id, bookingId));
}

/** Create or update the event for a live booking in one calendar. Safe to run any number of times. */
async function upsertEvent(
  deps: GoogleDeps,
  rt: GoogleRuntime,
  bundle: BookingBundle,
): Promise<void> {
  const bookingId = bundle.booking.id;
  const input = buildBookingEvent({
    bundle,
    appUrl: requireAppUrl(deps.env),
    timeZone: rt.timezone,
  });
  const existingId = bundle.booking.gcalEventId;
  const eventId = existingId ?? deterministicEventId(bookingId);

  if (existingId) {
    try {
      await rt.port.patchEvent(rt.calendarId, eventId, { ...input, status: "confirmed" });
      return;
    } catch (error) {
      // The event was removed from the calendar by hand (or lives in another stylist's
      // calendar after a reassignment): recreate it below.
      if (!isMissing(error)) throw error;
    }
  }

  try {
    await rt.port.insertEvent(rt.calendarId, eventId, input);
  } catch (error) {
    if (!(error instanceof ProviderConflictError)) throw error;
    // A previous attempt created it (or it exists in a cancelled state): bring it up to date.
    await rt.port.patchEvent(rt.calendarId, eventId, { ...input, status: "confirmed" });
  }
  if (existingId !== eventId) await saveEventId(deps, bookingId, eventId);
}

async function deleteFromCalendar(rt: GoogleRuntime, eventId: string): Promise<void> {
  try {
    await rt.port.deleteEvent(rt.calendarId, eventId);
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
}

/**
 * Run one account's share of an event. A failure is recorded on that account only (a revoked
 * token flips just that account to 'error'). Returns whether it succeeded; transient failures
 * are collected so the caller can rethrow and let the queue retry.
 */
async function guarded(
  deps: GoogleDeps,
  rt: GoogleRuntime,
  failures: unknown[],
  work: () => Promise<void>,
  options: { markSuccess: boolean },
): Promise<boolean> {
  try {
    await work();
    if (options.markSuccess) {
      await recordSuccess(deps.db, "google", deps.now(), rt.account.staffId);
    }
    return true;
  } catch (error) {
    await reportGoogleFailure(deps, error, rt.account.staffId);
    if (!(error instanceof AuthRevokedError)) failures.push(error);
    return false;
  }
}

async function pushEvent(
  deps: GoogleDeps,
  runtimes: GoogleRuntime[],
  event: IncomingDomainEvent & { bookingId: string },
): Promise<void> {
  const bundle = await loadBookingBundle(deps.db, event.bookingId);
  if (!bundle) {
    deps.log({
      event: "google_outbound_skipped",
      reason: "booking_not_found",
      bookingId: event.bookingId,
    });
    return;
  }
  if (!LIVE_STATUSES.includes(bundle.booking.status)) {
    // The booking was cancelled before we got here; the cancel event removes any event.
    deps.log({ event: "google_outbound_skipped", reason: "not_live", bookingId: event.bookingId });
    return;
  }

  // The stylist's own calendar, else the business-wide one, else nothing.
  const target = pickOutboundRuntime(runtimes, bundle.booking.staffId);
  const existingId = bundle.booking.gcalEventId;
  const failures: unknown[] = [];

  if (target) {
    await guarded(deps, target, failures, () => upsertEvent(deps, target, bundle), {
      markSuccess: true,
    });
  } else {
    deps.log({
      event: "google_outbound_skipped",
      reason: "no_calendar_for_stylist",
      bookingId: event.bookingId,
    });
  }

  // A reschedule may have moved the booking to another stylist: take the event out of every
  // other connected calendar (a missing event is fine).
  let sweptClean = true;
  if (event.type === "booking.rescheduled" && existingId) {
    for (const rt of runtimes) {
      if (rt === target) continue;
      const ok = await guarded(deps, rt, failures, () => deleteFromCalendar(rt, existingId), {
        markSuccess: false,
      });
      sweptClean = sweptClean && ok;
    }
    if (!target && sweptClean) await saveEventId(deps, event.bookingId, null);
  }
  if (failures.length > 0) throw failures[0];
}

async function removeEvent(
  deps: GoogleDeps,
  runtimes: GoogleRuntime[],
  bookingId: string,
): Promise<void> {
  const bundle = await loadBookingBundle(deps.db, bookingId);
  const eventId = bundle?.booking.gcalEventId;
  if (!eventId) return;

  // The event could be in the stylist's calendar or the business-wide one (it moves when the
  // stylist changes or connects later), so remove it from every connected calendar.
  const failures: unknown[] = [];
  let allRemoved = true;
  for (const rt of runtimes) {
    const ok = await guarded(deps, rt, failures, () => deleteFromCalendar(rt, eventId), {
      markSuccess: true,
    });
    allRemoved = allRemoved && ok;
  }
  if (allRemoved) await saveEventId(deps, bookingId, null);
  if (failures.length > 0) throw failures[0];
}

/**
 * Consumer for `consumer.google`. Ignores event types it does not handle and is idempotent,
 * so queue redelivery is harmless. A booking's event goes to the booking stylist's own calendar
 * when they have connected one, else the business-wide calendar, else nowhere. A transient
 * failure is recorded on the account and rethrown so the queue retries with backoff; a revoked
 * token flips only that account to 'error' and its share of the event is dropped (the reconcile
 * job re-pushes after the owner reconnects).
 */
export async function handleGoogleDomainEvent(
  deps: GoogleDeps,
  event: IncomingDomainEvent,
): Promise<void> {
  const { bookingId } = event;
  if (!HANDLED.has(event.type) || !bookingId) return;

  const runtimes = await loadAllGoogleRuntimes(deps);
  if (runtimes.length === 0) {
    deps.log({ event: "google_outbound_skipped", reason: "not_connected", type: event.type });
    return;
  }

  if (event.type === "booking.confirmed" || event.type === "booking.rescheduled") {
    await pushEvent(deps, runtimes, { ...event, bookingId });
  } else {
    await removeEvent(deps, runtimes, bookingId);
  }
}

/** Used by the reconcile job: make sure one booking is reflected in the calendar. */
export async function pushBookingToCalendar(deps: GoogleDeps, bookingId: string): Promise<void> {
  await handleGoogleDomainEvent(deps, { type: "booking.confirmed", bookingId });
}
