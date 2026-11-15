import { getBusiness } from "@/server/admin-foundation/business";
import { commandApi, parseBody } from "@/server/api/handler";
import { clockOutCommand } from "@/server/timesheets/commands";
import { clockOutSchema } from "@/server/timesheets/schemas";

/** POST /api/v1/timesheets/clock/out { breakMinutes? } : end the open shift, with any unpaid break. */
export async function POST(request: Request) {
  return commandApi(["timesheets.clock"], request, async (ctx) => {
    const input = await parseBody(request, clockOutSchema);
    const { timezone } = await getBusiness(ctx.db);
    return clockOutCommand(
      { db: ctx.db, actor: ctx.actor, staffId: ctx.access.staffId, timezone },
      input,
    );
  });
}
