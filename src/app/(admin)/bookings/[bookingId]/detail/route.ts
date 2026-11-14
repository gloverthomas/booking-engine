import type { NextRequest } from "next/server";
import { connection } from "next/server";
import { z } from "zod";
import { getDb } from "@/db/client";
import { getOwnerSession } from "@/server/auth";
import { getBookingDetail } from "@/server/admin/bookings";

/** GET /bookings/:bookingId/detail : everything the booking drawer shows. */
export async function GET(
  _request: NextRequest,
  ctx: RouteContext<"/bookings/[bookingId]/detail">,
) {
  await connection();
  if (!(await getOwnerSession())) {
    return Response.json({ error: "Not signed in" }, { status: 401 });
  }
  const { bookingId } = await ctx.params;
  if (!z.uuid().safeParse(bookingId).success) {
    return Response.json({ error: "Booking not found" }, { status: 404 });
  }
  const detail = await getBookingDetail(getDb(), bookingId);
  if (!detail) return Response.json({ error: "Booking not found" }, { status: 404 });
  return Response.json({ booking: detail }, { headers: { "Cache-Control": "private, no-store" } });
}
