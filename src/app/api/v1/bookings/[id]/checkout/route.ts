import { checkoutBooking } from "@/server/admin/commands";
import { checkoutSchema } from "@/server/admin/schemas";
import { commandApi, parseBody } from "@/server/api/handler";
import { idParam, type IdContext } from "@/server/api/params";
import { errorResponse } from "@/server/api/respond";

/** POST /api/v1/bookings/:id/checkout { method: "cash" | "eftpos" | "other" } : records the balance paid outside the app and closes the booking. Card payments use the Tap to Pay endpoints instead. */
export async function POST(request: Request, context: IdContext) {
  try {
    const bookingId = await idParam(context);
    return await commandApi(["checkout"], request, async (ctx) =>
      checkoutBooking(ctx, {
        bookingId,
        ...(await parseBody(request, checkoutSchema.omit({ bookingId: true }))),
      }),
    );
  } catch (error) {
    return errorResponse(error);
  }
}
