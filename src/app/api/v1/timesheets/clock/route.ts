import { getBusiness } from "@/server/admin-foundation/business";
import { readApi } from "@/server/api/handler";
import { buildClockPayload } from "@/server/timesheets/clock-payload";

/** GET /api/v1/timesheets/clock : am I clocked in, since when, and where can I clock in. */
export async function GET(request: Request) {
  return readApi(["timesheets.clock"], request, async ({ db, access }) => {
    const { timezone } = await getBusiness(db);
    return buildClockPayload(db, { staffId: access.staffId, timezone });
  });
}
