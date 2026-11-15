import { z } from "zod";
import { listBookings } from "@/server/admin/bookings";
import { createStaffBooking } from "@/server/admin/commands";
import { createBookingSchema } from "@/server/admin/schemas";
import { CALENDAR_PERMISSIONS } from "@/server/admin/session";
import { commandApi, parseBody, parseQuery, readApi } from "@/server/api/handler";

const listQuery = z.object({
  filter: z.enum(["upcoming", "past", "cancelled"]).default("upcoming"),
  q: z.string().trim().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

/** GET /api/v1/bookings?filter=upcoming|past|cancelled&q=&limit= */
export async function GET(request: Request) {
  return readApi(CALENDAR_PERMISSIONS, request, async ({ db, access }) => {
    const q = parseQuery(request, listQuery);
    return { bookings: await listBookings(db, access, q) };
  });
}

/**
 * POST /api/v1/bookings : a booking made by staff (walk-ins, phone bookings). Confirmed straight away, no
 * deposit. `notifyClient: false` books silently. A stylist can only book into their own column.
 */
export async function POST(request: Request) {
  return commandApi(
    ["booking.create"],
    request,
    async (ctx) => createStaffBooking(ctx, await parseBody(request, createBookingSchema)),
    201,
  );
}
