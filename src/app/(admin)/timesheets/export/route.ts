import { connection } from "next/server";
import { getDb } from "@/db/client";
import { requireAccess } from "@/server/auth/access";
import { loadBusinessContext } from "@/server/reports/context";
import { entriesCsv, summaryCsv } from "@/server/timesheets/csv";
import { isTimesheetError } from "@/server/timesheets/errors";
import { timesheetQuerySchema } from "@/server/timesheets/schemas";
import { staffIdsFor, timesheetScopeFor } from "@/server/timesheets/scope";
import { weekStartOf } from "@/server/timesheets/time";
import { getWeeklyTimesheets } from "@/server/timesheets/weekly";

/**
 * CSV download of one week: /timesheets/export?week=YYYY-MM-DD&kind=summary|entries[&staff=<id>].
 * Roles without timesheets.viewAll always get only their own rows, whatever `staff` says.
 */
export async function GET(request: Request): Promise<Response> {
  await connection();
  const session = await requireAccess("timesheets.viewOwn");
  const url = new URL(request.url);
  const parsed = timesheetQuerySchema.safeParse(Object.fromEntries(url.searchParams));
  if (!parsed.success) return new Response("Invalid options", { status: 400 });

  const db = getDb();
  const { timezone } = await loadBusinessContext(db);
  let weekStart: string;
  try {
    weekStart = weekStartOf(parsed.data.week ?? new Date(), timezone);
  } catch (error) {
    if (isTimesheetError(error)) return new Response("Invalid week", { status: 400 });
    throw error;
  }
  const ids = staffIdsFor(timesheetScopeFor(session.role, session.staffId), parsed.data.staff);
  const sheets = await getWeeklyTimesheets(db, {
    timezone,
    weekStart,
    ...(ids === "all" ? {} : { staffIds: ids }),
  });
  const body =
    parsed.data.kind === "entries" ? entriesCsv(sheets, timezone) : summaryCsv(sheets);
  return new Response(body, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="timesheets-${parsed.data.kind}-${weekStart}.csv"`,
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
    },
  });
}
