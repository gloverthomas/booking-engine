import { connection } from "next/server";
import { ZodError } from "zod";
import { getDb } from "@/db/client";
import { requireOwner } from "@/server/auth";
import {
  ReportInputError,
  buildReportTable,
  isReportTableId,
  loadBusinessContext,
  resolveRange,
  resolveParams,
  tableToCsv,
} from "@/server/reports";

/**
 * CSV download for any report table: /reports/export/<table>?from=..&to=..&granularity=..&groupBy=..
 * Owner only. Cells are escaped, and text that a spreadsheet could run as a formula is neutralised (see csv.ts).
 */
export async function GET(
  request: Request,
  ctx: { params: Promise<{ table: string }> },
): Promise<Response> {
  await connection();
  await requireOwner();
  const { table: id } = await ctx.params;
  if (!isReportTableId(id)) return new Response("Unknown report table", { status: 404 });

  const db = getDb();
  const { timezone } = await loadBusinessContext(db);
  const now = new Date();
  const query = Object.fromEntries(new URL(request.url).searchParams);
  try {
    const params = resolveParams(query, timezone, now);
    resolveRange(timezone, params.from, params.to);
    const table = await buildReportTable(db, id, { timezone, now, query });
    const stamp = `${params.from}_to_${params.to}`;
    return new Response(tableToCsv(table), {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="${table.filename}_${stamp}.csv"`,
        "cache-control": "private, no-store",
        "x-content-type-options": "nosniff",
      },
    });
  } catch (error) {
    if (error instanceof ZodError || error instanceof ReportInputError) {
      return new Response("Invalid date range or options", { status: 400 });
    }
    throw error;
  }
}
