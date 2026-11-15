import { z } from "zod";
import { AdminError } from "../admin-foundation/errors";
import { recordAudit, type Actor } from "../audit";
import type { Db } from "../db-types";
import { systemClock, type Clock } from "../clock";
import { applyBookings, applyClients } from "./apply";
import {
  APPOINTMENT_ALIASES,
  CLIENT_ALIASES,
  autoMapAppointments,
  autoMapClients,
  type AppointmentField,
  type ClientField,
  type ColumnMap,
  type ImportKind,
} from "./fields";
import { loadCatalog } from "./load";
import { planAppointments } from "./plan-appointments";
import { planClients } from "./plan-clients";
import { parseCsv } from "./csv";
import {
  importOptionsSchema,
  type BookingOp,
  type ClientOp,
  type ImportIssue,
  type ImportOptions,
  type PlanSummary,
  type Unmapped,
} from "./types";

export { parseCsv } from "./csv";
export { autoMapAppointments, autoMapClients } from "./fields";
export type { ImportKind } from "./fields";
export { importOptionsSchema } from "./types";

const SOURCE = "timely";
const MAX_ROWS = 20_000;
const MAX_ISSUES_RETURNED = 200;

export const importRequestSchema = z.object({
  kind: z.enum(["clients", "appointments"]),
  csv: z.string().min(1, "The file is empty").max(15_000_000, "The file is too large"),
  /** Field -> header. Anything omitted is auto-detected. */
  mapping: z.record(z.string(), z.string().nullable()).default({}),
  options: importOptionsSchema.default(importOptionsSchema.parse({})),
  /** false applies the plan; the same request with dryRun true only reports. */
  dryRun: z.boolean().default(true),
});
export type ImportRequest = z.infer<typeof importRequestSchema>;

export interface ImportReport {
  kind: ImportKind;
  dryRun: boolean;
  headers: string[];
  mapping: Record<string, string | null>;
  fields: string[];
  summary: PlanSummary;
  unmapped: Unmapped;
  /** Errors first, then warnings, capped. */
  issues: ImportIssue[];
  issueCount: number;
  /** Counts of what was written; null on a dry run. */
  applied: { created: number; linked: number; failed: number } | null;
  /** A handful of normalised rows so the owner can check the mapping looks right. */
  preview: Array<Record<string, string>>;
}

function mergeMapping<F extends string>(
  detected: ColumnMap<F>,
  override: Record<string, string | null>,
  headers: readonly string[],
): ColumnMap<F> {
  const merged = { ...detected } as ColumnMap<F>;
  for (const field of Object.keys(detected) as F[]) {
    if (!(field in override)) continue;
    const header = override[field];
    merged[field] = header && headers.includes(header) ? header : null;
  }
  return merged;
}

function rank(issues: readonly ImportIssue[]): ImportIssue[] {
  return [...issues].sort((a, b) =>
    a.level === b.level ? a.row - b.row : a.level === "error" ? -1 : 1,
  );
}

const countBy = (issues: readonly ImportIssue[], level: ImportIssue["level"]) =>
  issues.filter((i) => i.level === level).length;

export interface RunImportDeps {
  actor: Actor;
  clock?: Clock;
}

/** Plan an import and, unless it is a dry run, apply it. Stateless, so safe to run again on the same file. */
export async function runImport(
  db: Db,
  input: ImportRequest,
  deps: RunImportDeps,
): Promise<ImportReport> {
  const { headers, records } = parseCsv(input.csv);
  if (headers.length === 0)
    throw new AdminError(
      "invalid_file",
      "The file has no header row. Export it as CSV and try again.",
    );
  if (records.length > MAX_ROWS)
    throw new AdminError(
      "invalid_file",
      `Too many rows (${records.length}). Import at most ${MAX_ROWS} at a time.`,
    );

  const catalog = await loadCatalog(db, deps.clock ?? systemClock);
  const options: ImportOptions = input.options;
  const preview = records.slice(0, 5);

  if (input.kind === "clients") {
    const mapping = mergeMapping<ClientField>(autoMapClients(headers), input.mapping, headers);
    const plan = planClients(records, mapping, catalog, SOURCE);
    const applied = input.dryRun ? null : await applyClients(db, plan.ops, catalog.businessId);
    return finish(db, input, deps, {
      headers,
      mapping,
      fields: Object.keys(CLIENT_ALIASES),
      ops: plan.ops,
      issues: [...plan.issues, ...(applied?.issues ?? [])],
      unmapped: { staff: [], locations: [], services: [] },
      applied,
      preview,
      total: records.length,
    });
  }

  const mapping = mergeMapping<AppointmentField>(
    autoMapAppointments(headers),
    input.mapping,
    headers,
  );
  const plan = planAppointments(records, mapping, catalog, options, SOURCE);
  const applied = input.dryRun
    ? null
    : await applyBookings(db, plan.ops, {
        sendReminders: options.sendReminders,
        now: catalog.now,
        businessId: catalog.businessId,
      });
  return finish(db, input, deps, {
    headers,
    mapping,
    fields: Object.keys(APPOINTMENT_ALIASES),
    ops: plan.ops,
    issues: [...plan.issues, ...(applied?.issues ?? [])],
    unmapped: plan.unmapped,
    applied,
    preview,
    total: records.length,
  });
}

async function finish(
  db: Db,
  input: ImportRequest,
  deps: RunImportDeps,
  r: {
    headers: string[];
    mapping: Record<string, string | null>;
    fields: string[];
    ops: ReadonlyArray<ClientOp | BookingOp>;
    issues: ImportIssue[];
    unmapped: Unmapped;
    applied: { created: number; linked: number; failed: number } | null;
    preview: Array<Record<string, string>>;
    total: number;
  },
): Promise<ImportReport> {
  const tally = (action: string) => r.ops.filter((o) => o.action === action).length;
  const ranked = rank(r.issues);
  const summary: PlanSummary = {
    total: r.total,
    create: tally("create"),
    link: tally("link"),
    unchanged: tally("unchanged"),
    skip: r.total - r.ops.filter((o) => o.action !== "skip").length,
    errors: countBy(r.issues, "error"),
    warnings: countBy(r.issues, "warning"),
  };

  if (!input.dryRun && r.applied) {
    await recordAudit(db, {
      actor: deps.actor,
      action: "import.run",
      entityType: "import",
      data: {
        source: SOURCE,
        kind: input.kind,
        rows: r.total,
        ...r.applied,
        errors: summary.errors,
      },
    });
  }

  return {
    kind: input.kind,
    dryRun: input.dryRun,
    headers: r.headers,
    mapping: r.mapping,
    fields: r.fields,
    summary,
    unmapped: r.unmapped,
    issues: ranked.slice(0, MAX_ISSUES_RETURNED),
    issueCount: ranked.length,
    applied: r.applied && {
      created: r.applied.created,
      linked: r.applied.linked,
      failed: r.applied.failed,
    },
    preview: r.preview,
  };
}
