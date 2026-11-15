import { z } from "zod";
import { cardPaymentStatus, startCardPayment } from "@/server/admin/card-payments";
import { commandApi, parseQuery } from "@/server/api/handler";
import { idParam, type IdContext } from "@/server/api/params";
import { errorResponse } from "@/server/api/respond";

/**
 * POST /api/v1/bookings/:id/card-payment : opens a Tap to Pay payment for the balance owing and returns the
 * client secret for the Terminal SDK. The amount is the server's, never the phone's. Safe to repeat: it
 * resumes the open payment while the amount is unchanged.
 */
export async function POST(request: Request, context: IdContext) {
  try {
    const bookingId = await idParam(context);
    return await commandApi(
      ["checkout"],
      request,
      (ctx) => startCardPayment(ctx, { bookingId }),
      201,
    );
  } catch (error) {
    return errorResponse(error);
  }
}

const statusQuery = z.object({ paymentId: z.uuid() });

/**
 * GET /api/v1/bookings/:id/card-payment?paymentId= : after the tap, the app polls this until the payment is
 * `succeeded` and the booking `completed` (Stripe's webhook does both).
 */
export async function GET(request: Request, context: IdContext) {
  try {
    const bookingId = await idParam(context);
    return await commandApi(["checkout"], request, (ctx) =>
      cardPaymentStatus(ctx, { bookingId, ...parseQuery(request, statusQuery) }),
    );
  } catch (error) {
    return errorResponse(error);
  }
}
