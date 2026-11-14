import type { NextRequest } from "next/server";
import { getDb } from "@/db/client";
import { getOwnerSession } from "@/server/auth";
import { listCalendarEvents } from "@/server/admin/calendar";
import { calendarQuerySchema, queryToObject } from "@/server/admin/schemas";

/** GET /calendar/events?from=&to=&locationId=&staffId= : JSON events for the visible calendar range. */
export async function GET(request: NextRequest) {
  const query = queryToObject(request.nextUrl.searchParams);
  if (!(await getOwnerSession())) {
    return Response.json({ error: "Not signed in" }, { status: 401 });
  }
  const parsed = calendarQuerySchema.safeParse(query);
  if (!parsed.success) {
    return Response.json({ error: "Invalid calendar range" }, { status: 400 });
  }
  const { from, to, locationId, staffId } = parsed.data;
  const events = await listCalendarEvents(getDb(), { from, to }, locationId, staffId);
  return Response.json({ events }, { headers: { "Cache-Control": "private, no-store" } });
}
