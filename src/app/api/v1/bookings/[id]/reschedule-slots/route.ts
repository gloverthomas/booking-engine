import { z } from "zod";
import { rescheduleSlots } from "@/server/admin/reschedule-slots";
import { commandApi, parseQuery } from "@/server/api/handler";
import { idParam, type IdContext } from "@/server/api/params";
import { errorResponse } from "@/server/api/respond";

const MAX_SPAN_DAYS = 14;
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");

const query = z
  .object({ fromDate: date, toDate: date })
  .refine((q) => q.toDate >= q.fromDate, { message: "toDate is before fromDate", path: ["toDate"] })
  .refine((q) => (Date.parse(q.toDate) - Date.parse(q.fromDate)) / 86_400_000 <= MAX_SPAN_DAYS, {
    message: `Ask for at most ${MAX_SPAN_DAYS + 1} days at a time`,
    path: ["toDate"],
  });

/**
 * GET /api/v1/bookings/:id/reschedule-slots?fromDate=&toDate= : times this appointment could move to (same
 * stylist and services), with its own current slot counted as free. `reason` explains an empty answer.
 */
export async function GET(request: Request, context: IdContext) {
  try {
    const bookingId = await idParam(context);
    return await commandApi(["booking.edit"], request, (ctx) =>
      rescheduleSlots(ctx, { bookingId, ...parseQuery(request, query) }),
    );
  } catch (error) {
    return errorResponse(error);
  }
}
