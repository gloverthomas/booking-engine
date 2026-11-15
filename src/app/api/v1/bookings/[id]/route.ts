import { getBookingDetail } from "@/server/admin/bookings";
import { CALENDAR_PERMISSIONS } from "@/server/admin/session";
import { readApi } from "@/server/api/handler";
import { idParam, type IdContext } from "@/server/api/params";
import { errorResponse } from "@/server/api/respond";

/** GET /api/v1/bookings/:id : everything about one booking, including payments and what the viewer may do. */
export async function GET(request: Request, context: IdContext) {
  try {
    const id = await idParam(context);
    return await readApi(CALENDAR_PERMISSIONS, request, ({ db, access }) =>
      getBookingDetail(db, id, access),
    );
  } catch (error) {
    return errorResponse(error);
  }
}
