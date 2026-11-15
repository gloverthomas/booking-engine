import { rescheduleStaffBooking } from "@/server/admin/commands";
import { rescheduleSchema } from "@/server/admin/schemas";
import { commandApi, parseBody } from "@/server/api/handler";
import { idParam, type IdContext } from "@/server/api/params";
import { errorResponse } from "@/server/api/respond";

/** POST /api/v1/bookings/:id/reschedule { newStart, notifyClient } */
export async function POST(request: Request, context: IdContext) {
  try {
    const bookingId = await idParam(context);
    return await commandApi(["booking.edit"], request, async (ctx) =>
      rescheduleStaffBooking(ctx, {
        bookingId,
        ...(await parseBody(request, rescheduleSchema.omit({ bookingId: true }))),
      }),
    );
  } catch (error) {
    return errorResponse(error);
  }
}
