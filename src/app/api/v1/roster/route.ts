import { DateTime } from "luxon";
import { z } from "zod";
import { getBusiness } from "@/server/admin-foundation/business";
import { parseQuery, readApi } from "@/server/api/handler";
import { getRosterOverview, rosterAccessFor } from "@/server/roster";
import { AccessDeniedError } from "@/server/auth/access-core";

const query = z.object({
  /** Any local date (YYYY-MM-DD) in the week to show. Defaults to this week. */
  week: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD")
    .optional(),
});

/**
 * GET /api/v1/roster?week= : who is working when, for the Monday-to-Sunday week containing `week`. Ranges are
 * minutes since local midnight. Everyone sees everyone if their role allows it; a stylist sees only their own row.
 */
export async function GET(request: Request) {
  return readApi(["roster.viewAll", "roster.viewOwn"], request, async ({ db, access }) => {
    const rosterAccess = rosterAccessFor(access.role);
    if (!rosterAccess) throw new AccessDeniedError("roster.viewOwn");
    const { week } = parseQuery(request, query);
    const { timezone } = await getBusiness(db);

    const own = rosterAccess.scope === "own";
    const staffIds = own ? (access.staffId ? [access.staffId] : []) : undefined;
    const today = DateTime.now().setZone(timezone).toISODate() as string;
    const overview = await getRosterOverview(db, { weekOf: week ?? today, staffIds });
    return {
      ...overview,
      timezone,
      today,
      canEdit: rosterAccess.canEdit,
      scope: rosterAccess.scope,
    };
  });
}
