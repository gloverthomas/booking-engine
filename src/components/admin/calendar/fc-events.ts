import type { EventInput } from "@fullcalendar/core";
import { readableTextColour, UNKNOWN_STAFF_COLOUR } from "@/server/admin/staff-colour";
import type { CalendarEvent } from "@/server/admin/types";
import { toWallClock } from "./wallclock";

/** Location shows as a coloured edge stripe (six slots in calendar.css); the fill is the stylist's colour. */
const LOCATION_SLOTS = 6;

export function locationSlot(locationIds: readonly string[], locationId: string): number {
  const index = locationIds.indexOf(locationId);
  return (index === -1 ? 0 : index) % LOCATION_SLOTS;
}

const DRAGGABLE_STATUSES = new Set(["pending_payment", "confirmed"]);

export interface StaffLookup {
  name: string;
  colour: string;
}

/** Map a server calendar event to a FullCalendar event shown on the business-local wall clock. */
export function toFullCalendarEvent(
  event: CalendarEvent,
  timezone: string,
  locationIds: readonly string[],
  staff?: ReadonlyMap<string, StaffLookup>,
): EventInput {
  const start = toWallClock(new Date(event.start), timezone);
  const end = toWallClock(new Date(event.end), timezone);
  const stylist = staff?.get(event.staffId);
  const colour = stylist?.colour ?? UNKNOWN_STAFF_COLOUR;
  // Only worth naming people once there is more than one stylist to tell apart.
  const staffName = staff && staff.size > 1 ? (stylist?.name ?? null) : null;

  if (event.kind === "booking") {
    return {
      id: event.id,
      start,
      end,
      title: event.clientName,
      editable: DRAGGABLE_STATUSES.has(event.status),
      backgroundColor: colour,
      textColor: readableTextColour(colour),
      classNames: [
        "cal-ev",
        ...(locationIds.length > 1
          ? [`cal-loc-${locationSlot(locationIds, event.locationId)}`]
          : []),
        `cal-status-${event.status}`,
      ],
      extendedProps: {
        kind: "booking",
        status: event.status,
        services: event.services,
        staffName,
        staffColour: colour,
      },
    };
  }

  const base = event.reason ?? (event.kind === "external" ? "Busy (Google Calendar)" : "Blocked");
  return {
    id: `${event.kind}:${event.id}`,
    start,
    end,
    title: staffName ? `${base} · ${staffName}` : base,
    editable: false,
    borderColor: colour,
    classNames: [event.kind === "external" ? "cal-external" : "cal-block"],
    extendedProps: { kind: event.kind, blockId: event.id, reason: event.reason },
  };
}
