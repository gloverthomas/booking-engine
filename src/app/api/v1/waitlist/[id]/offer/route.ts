import { commandApi, parseBody } from "@/server/api/handler";
import { staffActor } from "@/server/api/actor";
import { idParam, type IdContext } from "@/server/api/params";
import { errorResponse } from "@/server/api/respond";
import { offerSlot, offerSlotSchema } from "@/server/waitlist";

/**
 * POST /api/v1/waitlist/:id/offer { staffId, start, end } : offer this open time to this person, overriding the
 * automatic offers. They are told by the usual message pipeline. 409 if the time is no longer free.
 */
export async function POST(request: Request, context: IdContext) {
  try {
    const entryId = await idParam(context);
    return await commandApi(
      ["waitlist.manage"],
      request,
      async (ctx) => {
        const body = await parseBody(request, offerSlotSchema.omit({ entryId: true }));
        return offerSlot(ctx.db, { ...body, entryId }, staffActor(ctx.actor));
      },
      201,
    );
  } catch (error) {
    return errorResponse(error);
  }
}
