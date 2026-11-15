import Link from "next/link";
import { connection } from "next/server";
import { Suspense } from "react";
import { getDb } from "@/db/client";
import { EmptyState, PageHeader, buttonClasses } from "@/components/ui";
import { requireAccess } from "@/server/auth/access";
import { can } from "@/server/auth/permissions";
import { loadBusinessContext } from "@/server/reports/context";
import { reportScopeFor } from "@/server/reports/scope";
import { getPerformance, type MetricResult, type PerformanceRow } from "@/server/targets/performance";
import { performanceQuerySchema } from "@/server/targets/schemas";
import { shiftAnchor } from "@/server/targets/progress";
import { formatTargetValue, TARGET_METRIC_LABEL, type TargetMetric } from "@/server/targets/units";
import { ProgressBar } from "./_components/ProgressBar";

export const metadata = { title: "Team performance" };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;
const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

export default function TeamPage({ searchParams }: { searchParams: SearchParams }) {
  return (
    <Suspense
      fallback={
        <p role="status" className="py-10 text-ink-muted">
          Loading performance
        </p>
      }
    >
      <Loaded searchParams={searchParams} />
    </Suspense>
  );
}

const METRICS: ReadonlyArray<{ key: keyof Pick<PerformanceRow, "revenue" | "bookings" | "utilisation" | "rebookRate">; metric: TargetMetric }> = [
  { key: "revenue", metric: "revenue" },
  { key: "bookings", metric: "bookings" },
  { key: "utilisation", metric: "utilisation" },
  { key: "rebookRate", metric: "rebook_rate" },
];

function actualText(metric: TargetMetric, value: number | null): string {
  return value === null ? "No data" : formatTargetValue(metric, value);
}

async function Loaded({ searchParams }: { searchParams: SearchParams }) {
  await connection();
  const raw = await searchParams;
  const session = await requireAccess("reports.viewOwn");
  const parsed = performanceQuerySchema.safeParse({
    period: first(raw.period) || undefined,
    date: first(raw.date) || undefined,
  });
  const query = parsed.success ? parsed.data : { period: "week" as const, date: undefined };
  const db = getDb();
  const { timezone } = await loadBusinessContext(db);
  const scope = reportScopeFor(session.role, session.staffId);
  const canManage = can(session.role, "staff.manage");

  const header = (
    <PageHeader
      eyebrow="Team"
      title="Performance"
      description="Actual against target for the week or month. Revenue is cash received, as in the reports."
      actions={
        canManage ? (
          <Link className={buttonClasses({ variant: "secondary" })} href="/team/targets">
            Manage targets
          </Link>
        ) : undefined
      }
    />
  );
  if (scope.kind === "none") {
    return (
      <div className="flex flex-col gap-6">
        {header}
        <EmptyState
          title="Nothing to show yet"
          description="Your login is not linked to a staff profile. Ask the owner to link it under Staff."
        />
      </div>
    );
  }

  const report = await getPerformance(db, {
    timezone,
    period: query.period,
    anchorDate: query.date,
    scope,
    now: new Date(),
  });
  const href = (period: string, date: string) =>
    `/team?${new URLSearchParams({ period, date }).toString()}`;
  const rows = [...(report.business ? [report.business] : []), ...report.rows];

  return (
    <div className="flex flex-col gap-6">
      {header}
      <nav aria-label="Period" className="flex flex-wrap items-center gap-2">
        {(["week", "month"] as const).map((p) => (
          <Link
            key={p}
            className={buttonClasses({ variant: query.period === p ? "primary" : "secondary", size: "sm" })}
            href={href(p, report.range.from)}
            aria-current={query.period === p ? "page" : undefined}
          >
            {p === "week" ? "Week" : "Month"}
          </Link>
        ))}
        <Link className={buttonClasses({ variant: "secondary", size: "sm" })} href={href(query.period, shiftAnchor(report.range, -1))}>
          Previous
        </Link>
        <Link className={buttonClasses({ variant: "secondary", size: "sm" })} href={href(query.period, shiftAnchor(report.range, 1))}>
          Next
        </Link>
        <h2 className="ml-2 text-lg font-semibold">
          {report.range.label}
          <span className="ml-2 text-sm font-normal text-ink-muted">
            {report.ended ? "finished" : `${report.elapsedPct}% through`}
          </span>
        </h2>
      </nav>

      {rows.length === 0 ? (
        <EmptyState title="No stylists to show" />
      ) : (
        <ul className="grid gap-4 lg:grid-cols-2">
          {rows.map((row) => (
            <li key={row.staffId ?? "business"} className="rounded-card border border-line bg-surface p-4">
              <h3 className="text-lg font-semibold">{row.name}</h3>
              <dl className="mt-3 flex flex-col gap-4">
                {METRICS.map(({ key, metric }) => (
                  <MetricBlock
                    key={key}
                    name={`${row.name}, ${TARGET_METRIC_LABEL[metric]}`}
                    metric={metric}
                    result={row[key]}
                    elapsedPct={report.elapsedPct}
                    detail={
                      metric === "utilisation"
                        ? `${row.detail.bookedHours}h booked of ${row.detail.rosteredHours}h rostered`
                        : metric === "rebook_rate"
                          ? `${row.detail.rebooked} of ${row.detail.rebookEligible} visits rebooked`
                          : undefined
                    }
                  />
                ))}
              </dl>
            </li>
          ))}
        </ul>
      )}
      <p className="text-sm text-ink-muted">
        Utilisation is booked hours over rostered hours. Rebook rate counts completed visits whose client booked
        again within 28 days, once those 28 days have passed. The tick on each bar shows how far through the
        period we are.
      </p>
    </div>
  );
}

function MetricBlock({
  name,
  metric,
  result,
  elapsedPct,
  detail,
}: {
  name: string;
  metric: TargetMetric;
  result: MetricResult;
  elapsedPct: number;
  detail?: string;
}) {
  return (
    <div className="flex flex-col gap-1">
      <dt className="eyebrow">{TARGET_METRIC_LABEL[metric]}</dt>
      <dd className="flex flex-col gap-1">
        <span className="flex flex-wrap items-baseline gap-x-2">
          <span className="text-2xl font-semibold tabular-nums">{actualText(metric, result.actual)}</span>
          {result.target !== null ? (
            <span className="text-ink-muted">of {formatTargetValue(metric, result.target)}</span>
          ) : (
            <span className="text-ink-subtle">No target set</span>
          )}
        </span>
        {detail ? <span className="text-sm text-ink-muted">{detail}</span> : null}
        {result.progress ? (
          <ProgressBar progress={result.progress} elapsedPct={elapsedPct} label={name} />
        ) : null}
      </dd>
    </div>
  );
}
