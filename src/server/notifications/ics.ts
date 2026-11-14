import { createEvent } from "ics";
import type { BookingContext } from "./booking-context";

function utcParts(date: Date): [number, number, number, number, number] {
  return [
    date.getUTCFullYear(),
    date.getUTCMonth() + 1,
    date.getUTCDate(),
    date.getUTCHours(),
    date.getUTCMinutes(),
  ];
}

/**
 * A calendar invite for the appointment. The UID is stable per booking so a "moved" email's file
 * updates the earlier event instead of adding a second one; `sequence` must increase on a change.
 */
export function buildIcs(
  ctx: BookingContext,
  options: { sequence?: number; manageUrl: string },
): string {
  const { error, value } = createEvent({
    uid: `${ctx.bookingId}@booking-engine`,
    sequence: options.sequence ?? 0,
    start: utcParts(ctx.start),
    startInputType: "utc",
    startOutputType: "utc",
    end: utcParts(ctx.end),
    endInputType: "utc",
    endOutputType: "utc",
    title: `${ctx.services.map((s) => s.name).join(" + ") || "Appointment"} with ${ctx.staffName}`,
    description: `Manage your booking: ${options.manageUrl}`,
    location: [ctx.location.name, ctx.location.address].filter(Boolean).join(", "),
    url: options.manageUrl,
    status: "CONFIRMED",
    busyStatus: "BUSY",
  });
  if (error || !value) throw new Error(`Could not build calendar file: ${String(error)}`);
  return value;
}
