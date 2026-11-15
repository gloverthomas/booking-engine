import { connection } from "next/server";
import { unstable_rethrow } from "next/navigation";
import { getDb } from "@/db/client";
import { AccessDeniedError, requireAccess } from "@/server/auth/access";
import { loadBusinessContext } from "@/server/reports/context";
import { buildClockPayload } from "@/server/timesheets/clock-payload";

/** Current clock state for the signed-in person: the Clock widget polls this. Never cached. */
export async function GET(): Promise<Response> {
  await connection();
  const headers = { "cache-control": "private, no-store" };
  try {
    const session = await requireAccess("timesheets.clock");
    const db = getDb();
    const { timezone } = await loadBusinessContext(db);
    const payload = await buildClockPayload(db, { staffId: session.staffId, timezone });
    return Response.json(payload, { headers });
  } catch (error) {
    unstable_rethrow(error); // a redirect to /login must go through
    if (error instanceof AccessDeniedError) {
      return Response.json({ available: false }, { status: 403, headers });
    }
    throw error;
  }
}
