import { listCalendarEvents } from "@/server/admin/calendar";
import { calendarQuerySchema } from "@/server/admin/schemas";
import { CALENDAR_PERMISSIONS } from "@/server/admin/session";
import { parseQuery, readApi } from "@/server/api/handler";

/**
 * GET /api/v1/calendar?from=&to=&locationId=&staffIds=a,b
 * Bookings and time blocks in a range (at most 62 days). A stylist only ever receives their own column.
 */
export async function GET(request: Request) {
  return readApi(CALENDAR_PERMISSIONS, request, async ({ db, access }) => {
    const q = parseQuery(request, calendarQuerySchema);
    const events = await listCalendarEvents(db, { from: q.from, to: q.to }, access, {
      locationId: q.locationId,
      staffIds: q.staffIds,
    });
    return { events };
  });
}
