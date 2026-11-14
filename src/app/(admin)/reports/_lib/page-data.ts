import { connection } from "next/server";
import { ZodError } from "zod";
import { getDb } from "@/db/client";
import { requireOwner } from "@/server/auth";
import {
  ReportInputError,
  defaultRange,
  loadBusinessContext,
  rangePresets,
  resolveParams,
  resolveRange,
  type RangePreset,
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
}

/** Guard the page (owner only), then resolve the date range and options from the URL. Runs at request time. */
export async function loadReportPage(searchParams: SearchParams): Promise<ReportPageContext> {
  // Request time only: never prerender a page that reads the session and the database.
  await connection();
  const query = await searchParams;
  await requireOwner();
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
  return {
    db,
    timezone,
    now,
    params,
    presets: rangePresets(now, timezone),
    query: inputError ? {} : query,
    inputError,
  };
}

/** Query string for links that keep the current filters (and override some). */
export function queryString(
  params: ResolvedParams,
  overrides: Partial<Record<"from" | "to" | "granularity" | "groupBy", string>> = {},
): string {
  const merged = { ...params, ...overrides };
  return new URLSearchParams({
    from: merged.from,
    to: merged.to,
    granularity: merged.granularity,
    groupBy: merged.groupBy,
  }).toString();
}
