import type { NextRequest } from "next/server";
import { withReadContext, jsonBadRequest, jsonOk } from "@/server/admin/api";
import { listCalendarEvents } from "@/server/admin/calendar";
import { calendarQuerySchema, queryToObject } from "@/server/admin/schemas";

/**
 * GET /calendar/events?from=&to=&locationId=&staffIds=a,b : JSON events for the visible calendar range.
 * A stylist always gets only their own bookings and blocks, whatever `staffIds` says.
 */
export async function GET(request: NextRequest) {
  const query = queryToObject(request.nextUrl.searchParams);
  return withReadContext(["calendar.viewAll", "calendar.viewOwn"], async ({ db, access }) => {
    const parsed = calendarQuerySchema.safeParse(query);
    if (!parsed.success) return jsonBadRequest("Invalid calendar range");
    const { from, to, locationId, staffIds } = parsed.data;
    const events = await listCalendarEvents(db, { from, to }, access, { locationId, staffIds });
    return jsonOk({ events });
  });
}
