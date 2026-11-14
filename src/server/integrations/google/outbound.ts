import { eq } from "drizzle-orm";
import { booking } from "@/db/schema";
import { recordSuccess } from "../common/account-store";
import { LIVE_STATUSES, loadBookingBundle } from "../common/booking-data";
import { requireAppUrl } from "../common/env";
import {
  AuthRevokedError,
  ProviderConflictError,
  ProviderGoneError,
  ProviderNotFoundError,
} from "../common/errors";
import { buildBookingEvent, deterministicEventId } from "./event-mapper";
import {
  loadGoogleRuntime,
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

/** Create or update the event for a live booking. Safe to run any number of times. */
async function upsertEvent(deps: GoogleDeps, rt: GoogleRuntime, bookingId: string): Promise<void> {
  const bundle = await loadBookingBundle(deps.db, bookingId);
  if (!bundle) {
    deps.log({ event: "google_outbound_skipped", reason: "booking_not_found", bookingId });
    return;
  }
  if (!LIVE_STATUSES.includes(bundle.booking.status)) {
    // The booking was cancelled before we got here; the cancel event removes any event.
    deps.log({ event: "google_outbound_skipped", reason: "not_live", bookingId });
    return;
  }

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
      // The event was removed from the calendar by hand: recreate it below.
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

async function removeEvent(deps: GoogleDeps, rt: GoogleRuntime, bookingId: string): Promise<void> {
  const bundle = await loadBookingBundle(deps.db, bookingId);
  const eventId = bundle?.booking.gcalEventId;
  if (!eventId) return;
  try {
    await rt.port.deleteEvent(rt.calendarId, eventId);
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  await saveEventId(deps, bookingId, null);
}

/**
 * Consumer for `consumer.google`. Ignores event types it does not handle and is idempotent,
 * so queue redelivery is harmless. A transient failure is recorded on the account and
 * rethrown so the queue retries with backoff; a revoked token flips the account to 'error'
 * and the event is dropped (the reconcile job re-pushes after the owner reconnects).
 */
export async function handleGoogleDomainEvent(
  deps: GoogleDeps,
  event: IncomingDomainEvent,
): Promise<void> {
  if (!HANDLED.has(event.type) || !event.bookingId) return;

  const rt = await loadGoogleRuntime(deps);
  if (!rt) {
    deps.log({ event: "google_outbound_skipped", reason: "not_connected", type: event.type });
    return;
  }

  try {
    if (event.type === "booking.confirmed" || event.type === "booking.rescheduled") {
      await upsertEvent(deps, rt, event.bookingId);
    } else {
      await removeEvent(deps, rt, event.bookingId);
    }
    await recordSuccess(deps.db, "google", deps.now());
  } catch (error) {
    await reportGoogleFailure(deps, error);
    if (error instanceof AuthRevokedError) return;
    throw error;
  }
}

/** Used by the reconcile job: make sure one booking is reflected in the calendar. */
export async function pushBookingToCalendar(deps: GoogleDeps, bookingId: string): Promise<void> {
  await handleGoogleDomainEvent(deps, { type: "booking.confirmed", bookingId });
}
