import { DateTime } from "luxon";
import { clientFullName, type BookingBundle } from "../common/booking-data";
import {
  EVENT_BOOKING_KEY,
  EVENT_SOURCE_KEY,
  EVENT_SOURCE_VALUE,
  type CalendarEventInput,
  type GoogleCalendarEvent,
} from "./port";

/**
 * Google lets us choose the event id (base32hex: a-v and 0-9, 5 to 1024 chars). A booking uuid
 * without dashes is 32 hex characters, so the id is stable and a retried insert cannot create a
 * duplicate event: it answers 409 instead.
 */
export function deterministicEventId(bookingId: string): string {
  return bookingId.replace(/-/g, "").toLowerCase();
}

export function adminBookingUrl(appUrl: string, bookingId: string): string {
  return `${appUrl}/bookings/${bookingId}`;
}

function locationText(location: BookingBundle["location"]): string {
  const cityLine = [location.suburb, location.state, location.postcode].filter(Boolean).join(" ");
  return [location.name, location.addressLine, cityLine].filter(Boolean).join(", ");
}

export interface BuildEventInput {
  bundle: BookingBundle;
  appUrl: string;
  timeZone: string;
}

/** The appointment itself: start to start + service durations (the buffer is not shown). */
export function buildBookingEvent({
  bundle,
  appUrl,
  timeZone,
}: BuildEventInput): CalendarEventInput {
  const { booking, client, location, services } = bundle;
  const start = booking.during.start;
  const serviceMinutes = services.reduce((total, s) => total + s.durationMin, 0);
  const end =
    serviceMinutes > 0 ? new Date(start.getTime() + serviceMinutes * 60_000) : booking.during.end;

  const serviceNames = services.map((s) => s.name).join(", ");
  const name = clientFullName(client);
  const summary = serviceNames ? `${name} - ${serviceNames}` : name;

  const lines = [
    `Client: ${name}`,
    client.phone ? `Phone: ${client.phone}` : undefined,
    serviceNames ? `Services: ${serviceNames}` : undefined,
    booking.comments ? `Client notes: ${booking.comments}` : undefined,
    `Open in admin: ${adminBookingUrl(appUrl, booking.id)}`,
  ].filter((line): line is string => Boolean(line));

  return {
    summary,
    description: lines.join("\n"),
    location: locationText(location),
    start,
    end,
    timeZone,
    privateProps: {
      [EVENT_BOOKING_KEY]: booking.id,
      [EVENT_SOURCE_KEY]: EVENT_SOURCE_VALUE,
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Inbound: Google event -> time block                                        */
/* -------------------------------------------------------------------------- */

export type BlockDecision =
  | { action: "upsert"; start: Date; end: Date; reason: string }
  | { action: "delete" }
  | { action: "skip" };

/** Event types that are not "I am busy": birthdays and working-location markers. */
const IGNORED_EVENT_TYPES = new Set(["birthday", "workingLocation"]);

export function isOurEvent(event: GoogleCalendarEvent): boolean {
  return event.extendedProperties?.private?.[EVENT_SOURCE_KEY] === EVENT_SOURCE_VALUE;
}

function isDeclinedBySelf(event: GoogleCalendarEvent): boolean {
  return (event.attendees ?? []).some((a) => a.self === true && a.responseStatus === "declined");
}

function localMidnight(isoDate: string, timeZone: string): Date | null {
  const dt = DateTime.fromISO(isoDate, { zone: timeZone }).startOf("day");
  return dt.isValid ? dt.toJSDate() : null;
}

/**
 * Decide what a Google event means for availability.
 * - events we created, and ignored event types: skip (they never become blocks)
 * - cancelled, free ("transparent") and declined events: delete any block we hold for them
 * - all-day events block every local day they cover (Google's end date is exclusive)
 */
export function classifyEvent(event: GoogleCalendarEvent, timeZone: string): BlockDecision {
  if (isOurEvent(event)) return { action: "skip" };
  if (event.eventType && IGNORED_EVENT_TYPES.has(event.eventType)) return { action: "delete" };
  if (event.status === "cancelled") return { action: "delete" };
  if (event.transparency === "transparent") return { action: "delete" };
  if (isDeclinedBySelf(event)) return { action: "delete" };

  const reason = event.summary?.trim() ? event.summary.trim() : "Busy (Google Calendar)";

  if (event.start?.date) {
    const start = localMidnight(event.start.date, timeZone);
    const endDate =
      event.end?.date ?? DateTime.fromISO(event.start.date).plus({ days: 1 }).toISODate();
    const end = endDate ? localMidnight(endDate, timeZone) : null;
    if (!start || !end || end <= start) return { action: "delete" };
    return { action: "upsert", start, end, reason };
  }

  if (event.start?.dateTime && event.end?.dateTime) {
    const start = new Date(event.start.dateTime);
    const end = new Date(event.end.dateTime);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) {
      return { action: "delete" };
    }
    return { action: "upsert", start, end, reason };
  }

  return { action: "skip" };
}
