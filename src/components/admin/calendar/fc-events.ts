import type { EventInput } from "@fullcalendar/core";
import type { CalendarEvent } from "@/server/admin/types";
import { toWallClock } from "./wallclock";

/** Colours rotate through six location slots defined in calendar.css. */
const LOCATION_SLOTS = 6;

export function locationSlot(locationIds: readonly string[], locationId: string): number {
  const index = locationIds.indexOf(locationId);
  return (index === -1 ? 0 : index) % LOCATION_SLOTS;
}

const DRAGGABLE_STATUSES = new Set(["pending_payment", "confirmed"]);

/** Map a server calendar event to a FullCalendar event shown on the business-local wall clock. */
export function toFullCalendarEvent(
  event: CalendarEvent,
  timezone: string,
  locationIds: readonly string[],
  staffNames?: ReadonlyMap<string, string>,
): EventInput {
  const start = toWallClock(new Date(event.start), timezone);
  const end = toWallClock(new Date(event.end), timezone);

  if (event.kind === "booking") {
    return {
      id: event.id,
      start,
      end,
      title: event.clientName,
      editable: DRAGGABLE_STATUSES.has(event.status),
      classNames: [
        "cal-ev",
        `cal-loc-${locationSlot(locationIds, event.locationId)}`,
        `cal-status-${event.status}`,
      ],
      extendedProps: {
        kind: "booking",
        status: event.status,
        services: event.services,
        // Only worth showing once there is more than one stylist to tell apart.
        staffName:
          staffNames && staffNames.size > 1 ? (staffNames.get(event.staffId) ?? null) : null,
      },
    };
  }

  return {
    id: `${event.kind}:${event.id}`,
    start,
    end,
    title: event.reason ?? (event.kind === "external" ? "Busy (Google Calendar)" : "Blocked"),
    editable: false,
    classNames: [event.kind === "external" ? "cal-external" : "cal-block"],
    extendedProps: { kind: event.kind, blockId: event.id, reason: event.reason },
  };
}
