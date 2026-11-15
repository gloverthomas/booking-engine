import { reassignStaffBooking } from "@/server/admin/commands";
import { reassignSchema } from "@/server/admin/schemas";
import { commandApi, parseBody } from "@/server/api/handler";
import { idParam, type IdContext } from "@/server/api/params";
import { errorResponse } from "@/server/api/respond";

/** POST /api/v1/bookings/:id/reassign { newStaffId, notifyClient } : moves it to another stylist. */
export async function POST(request: Request, context: IdContext) {
  try {
    const bookingId = await idParam(context);
    return await commandApi(["booking.edit"], request, async (ctx) =>
      reassignStaffBooking(ctx, {
        bookingId,
        ...(await parseBody(request, reassignSchema.omit({ bookingId: true }))),
      }),
    );
  } catch (error) {
    return errorResponse(error);
  }
}
