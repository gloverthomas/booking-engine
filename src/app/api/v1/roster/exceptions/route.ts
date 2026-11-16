import { DateTime } from "luxon";
import { z } from "zod";
import { getBusiness } from "@/server/admin-foundation/business";
import { rosterExceptionBody } from "@/server/api/bodies";
import { commandApi, parseBody, parseQuery, readApi } from "@/server/api/handler";
import { AccessDeniedError } from "@/server/auth/access-core";
import { listExceptions, rosterAccessFor, setCustomHours, setDayOff } from "@/server/roster";
import { isoDateSchema } from "@/server/roster/schemas";

const listQuery = z.object({ from: isoDateSchema.optional() });

/**
 * GET /api/v1/roster/exceptions?from= : days off and changed hours from `from` (default today) onward. A stylist
 * sees only their own.
 */
export async function GET(request: Request) {
  return readApi(["roster.viewAll", "roster.viewOwn"], request, async ({ db, access }) => {
    const rosterAccess = rosterAccessFor(access.role);
    if (!rosterAccess) throw new AccessDeniedError("roster.viewOwn");
    const { from } = parseQuery(request, listQuery);
    const { timezone } = await getBusiness(db);
    const today = DateTime.now().setZone(timezone).toISODate() as string;
    const own = rosterAccess.scope === "own";
    const exceptions = await listExceptions(db, {
      fromDate: from ?? today,
      staffIds: own ? (access.staffId ? [access.staffId] : []) : undefined,
    });
    return { exceptions };
  });
}

/**
 * POST /api/v1/roster/exceptions : mark a stylist off for a day (`kind: "off"`, one place or everywhere), or give
 * them different hours (`kind: "custom"`). Replaces what was set for that day and place. Returns how many
 * existing bookings now fall outside the roster; it never blocks the change. Owner and manager only.
 */
export async function POST(request: Request) {
  return commandApi(
    ["roster.editAll"],
    request,
    async (ctx) => {
      const input = await parseBody(request, rosterExceptionBody);
      return input.kind === "off"
        ? setDayOff(ctx.db, ctx.actor, input)
        : setCustomHours(ctx.db, ctx.actor, input);
    },
    201,
  );
}
