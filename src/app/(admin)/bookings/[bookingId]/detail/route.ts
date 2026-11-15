import type { NextRequest } from "next/server";
import { connection } from "next/server";
import { z } from "zod";
import { jsonNotFound, jsonOk, withReadContext } from "@/server/admin/api";
import { getBookingDetail } from "@/server/admin/bookings";

/**
 * GET /bookings/:bookingId/detail : everything the booking drawer shows. A stylist asking for someone
 * else's booking gets the same 404 as for a booking that does not exist.
 */
export async function GET(
  _request: NextRequest,
  ctx: RouteContext<"/bookings/[bookingId]/detail">,
) {
  await connection();
  const { bookingId } = await ctx.params;
  return withReadContext(["calendar.viewAll", "calendar.viewOwn"], async ({ db, access }) => {
    if (!z.uuid().safeParse(bookingId).success) return jsonNotFound("Booking not found");
    const detail = await getBookingDetail(db, bookingId, access);
    if (!detail) return jsonNotFound("Booking not found");
    return jsonOk({ booking: detail });
  });
}
