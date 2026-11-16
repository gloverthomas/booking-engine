import { z } from "zod";
import { parseQuery, readApi } from "@/server/api/handler";
import { listWaitlist } from "@/server/waitlist/admin";

const query = z.object({ view: z.enum(["active", "history"]).default("active") });

/** GET /api/v1/waitlist?view=active|history : who is waiting for a cancellation, with any offers made to them. */
export async function GET(request: Request) {
  return readApi(["waitlist.manage"], request, async ({ db }) => {
    const { view } = parseQuery(request, query);
    return { entries: await listWaitlist(db, view) };
  });
}
