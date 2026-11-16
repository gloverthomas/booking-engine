import { commandApi } from "@/server/api/handler";
import { staffActor } from "@/server/api/actor";
import { idParam, type IdContext } from "@/server/api/params";
import { errorResponse } from "@/server/api/respond";
import { removeEntry } from "@/server/waitlist";

/** DELETE /api/v1/waitlist/:id : take someone off the waitlist. Their open offers are withdrawn. */
export async function DELETE(request: Request, context: IdContext) {
  try {
    const entryId = await idParam(context);
    return await commandApi(["waitlist.manage"], request, async (ctx) => {
      await removeEntry(ctx.db, { entryId }, staffActor(ctx.actor));
      return { removed: true };
    });
  } catch (error) {
    return errorResponse(error);
  }
}
