import { getBusiness } from "@/server/admin-foundation/business";
import { commandApi, parseBody } from "@/server/api/handler";
import { clockInCommand } from "@/server/timesheets/commands";
import { clockInSchema } from "@/server/timesheets/schemas";

/** POST /api/v1/timesheets/clock/in { locationId? } : start a shift for the signed-in person (only ever themselves). */
export async function POST(request: Request) {
  return commandApi(["timesheets.clock"], request, async (ctx) => {
    const input = await parseBody(request, clockInSchema);
    const { timezone } = await getBusiness(ctx.db);
    return clockInCommand(
      { db: ctx.db, actor: ctx.actor, staffId: ctx.access.staffId, timezone },
      input,
    );
  });
}
