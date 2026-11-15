import { connection } from "next/server";
import { ZodError } from "zod";
import { getDb } from "@/db/client";
import { asc } from "drizzle-orm";
import { staff } from "@/db/schema";
import { requireAccess } from "@/server/auth/access";
import {
  ReportInputError,
  defaultRange,
  loadBusinessContext,
  rangePresets,
  resolveParams,
  resolveRange,
  reportScopeFor,
  scopedStaffId,
  type RangePreset,
  type ReportScope,
  type ReportParams,
} from "@/server/reports";

export type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export type ResolvedParams = ReportParams & { from: string; to: string };

export interface ReportPageContext {
  db: ReturnType<typeof getDb>;
  timezone: string;
  now: Date;
  params: ResolvedParams;
  presets: RangePreset[];
  /** Raw query, passed on to the table builders (they validate it again). */
  query: Record<string, string | string[] | undefined>;
  /** Set when the URL had bad input; the page shows it and falls back to month to date. */
  inputError: string | null;
  /** Whose numbers the signed-in person may see. Derived from their role on the server, never from the URL. */
  scope: ReportScope;
  /** The stylist every query is limited to: forced to themselves for own-only roles. */
  staffId: string | undefined;
  /** Stylists to pick from. Only for roles that see everyone. */
  staffOptions: Array<{ id: string; name: string }>;
  /** Passed to the table builders so they enforce the same scope. */
  tableContext: {
    timezone: string;
    now: Date;
    query: Record<string, string | string[] | undefined>;
    scope: ReportScope;
  };
}

/**
 * Guard the page, then resolve the date range and options from the URL. Runs at request time.
 * `level` "own" needs reports.viewOwn (stylists see only themselves); "all" needs reports.viewAll
 * (whole-business pages such as clients and outstanding balances).
 */
export async function loadReportPage(
  searchParams: SearchParams,
  level: "own" | "all" = "own",
): Promise<ReportPageContext> {
  // Request time only: never prerender a page that reads the session and the database.
  await connection();
  const query = await searchParams;
  const session = await requireAccess(level === "all" ? "reports.viewAll" : "reports.viewOwn");
  const scope = reportScopeFor(session.role, session.staffId);
  const db = getDb();
  const { timezone } = await loadBusinessContext(db);
  const now = new Date();
  let params: ResolvedParams;
  let inputError: string | null = null;
  try {
    params = resolveParams(query, timezone, now);
    resolveRange(timezone, params.from, params.to);
  } catch (error) {
    inputError =
      error instanceof ReportInputError
        ? error.message
        : error instanceof ZodError
          ? "One of the filters in the address was not valid, so the default range is shown."
          : "Could not read the date range.";
    params = { ...resolveParams({}, timezone, now), ...defaultRange(now, timezone) };
  }
  const effectiveQuery = inputError ? {} : query;
  const staffOptions =
    scope.kind === "all"
      ? await db.select({ id: staff.id, name: staff.name }).from(staff).orderBy(asc(staff.name))
      : [];
  return {
    db,
    timezone,
    now,
    params,
    presets: rangePresets(now, timezone),
    query: effectiveQuery,
    inputError,
    scope,
    staffId: scope.kind === "none" ? undefined : scopedStaffId(scope, params.staff),
    staffOptions,
    tableContext: { timezone, now, query: effectiveQuery, scope },
  };
}

/** Query string for links that keep the current filters (and override some). */
export function queryString(
  params: ResolvedParams,
  overrides: Partial<Record<"from" | "to" | "granularity" | "groupBy" | "staff", string>> = {},
): string {
  const merged = { ...params, ...overrides };
  const q = new URLSearchParams({
    from: merged.from,
    to: merged.to,
    granularity: merged.granularity,
    groupBy: merged.groupBy,
  });
  if (merged.staff) q.set("staff", merged.staff);
  return q.toString();
}
