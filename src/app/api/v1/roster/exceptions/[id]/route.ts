import { commandApi } from "@/server/api/handler";
import { idParam, type IdContext } from "@/server/api/params";
import { errorResponse } from "@/server/api/respond";
import { removeException } from "@/server/roster";

/** DELETE /api/v1/roster/exceptions/:id : put the stylist back on their weekly hours for that day. */
export async function DELETE(request: Request, context: IdContext) {
  try {
    const id = await idParam(context);
    return await commandApi(["roster.editAll"], request, async (ctx) => {
      await removeException(ctx.db, ctx.actor, id);
      return { removed: true };
    });
  } catch (error) {
    return errorResponse(error);
  }
}
