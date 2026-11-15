import { markBookingNoShow } from "@/server/admin/commands";
import { commandApi } from "@/server/api/handler";
import { idParam, type IdContext } from "@/server/api/params";
import { errorResponse } from "@/server/api/respond";

/** POST /api/v1/bookings/:id/no-show : marks a no-show and applies the policy (deposit kept, fee charged if set up). */
export async function POST(request: Request, context: IdContext) {
  try {
    const bookingId = await idParam(context);
    return await commandApi(["booking.edit"], request, (ctx) =>
      markBookingNoShow(ctx, { bookingId }),
    );
  } catch (error) {
    return errorResponse(error);
  }
}
