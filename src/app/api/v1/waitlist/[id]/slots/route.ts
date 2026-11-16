import { readApi } from "@/server/api/handler";
import { idParam, type IdContext } from "@/server/api/params";
import { errorResponse } from "@/server/api/respond";
import { listOfferableSlots } from "@/server/waitlist/admin";

/** GET /api/v1/waitlist/:id/slots : open times that suit this person (their stylist, dates and hours), soonest first. */
export async function GET(request: Request, context: IdContext) {
  try {
    const id = await idParam(context);
    return await readApi(["waitlist.manage"], request, ({ db }) => listOfferableSlots(db, id));
  } catch (error) {
    return errorResponse(error);
  }
}
