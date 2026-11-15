import { getClientProfile } from "@/server/admin/clients";
import { readApi } from "@/server/api/handler";
import { idParam, type IdContext } from "@/server/api/params";
import { errorResponse } from "@/server/api/respond";

/** GET /api/v1/clients/:id : profile, notes and booking history. */
export async function GET(request: Request, context: IdContext) {
  try {
    const id = await idParam(context);
    return await readApi(["clients.view"], request, ({ db, access }) =>
      getClientProfile(db, id, access),
    );
  } catch (error) {
    return errorResponse(error);
  }
}
