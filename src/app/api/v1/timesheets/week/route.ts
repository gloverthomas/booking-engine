import { DateTime } from "luxon";
import { z } from "zod";
import { getBusiness } from "@/server/admin-foundation/business";
import { parseQuery, readApi } from "@/server/api/handler";
import { weekStartOf } from "@/server/roster";
import { isoDateSchema } from "@/server/roster/schemas";
import { getWeeklyTimesheet } from "@/server/timesheets/weekly";

const query = z.object({ week: isoDateSchema.optional() });

/**
 * GET /api/v1/timesheets/week?week= : the signed-in person's own week: each day's entries, hours worked against
 * hours rostered, and what is waiting for approval. Approving and editing entries stay on the web, where a
 * reason is recorded.
 */
export async function GET(request: Request) {
  return readApi(["timesheets.viewOwn", "timesheets.viewAll"], request, async ({ db, access }) => {
    if (!access.staffId) return { available: false as const };
    const { week } = parseQuery(request, query);
    const { timezone } = await getBusiness(db);
    const today = DateTime.now().setZone(timezone).toISODate() as string;
    const sheet = await getWeeklyTimesheet(db, {
      timezone,
      weekStart: weekStartOf(week ?? today),
      staffId: access.staffId,
    });
    return sheet ? { available: true as const, sheet } : { available: false as const };
  });
}
