import { buildReportTable, formatAud, getCancellationsReport } from "@/server/reports";
import { DataTable } from "../_components/DataTable";
import { DateRangeForm } from "../_components/DateRangeForm";
import { ReportPageShell } from "../_components/ReportPageShell";
import { StatTiles } from "../_components/StatTiles";
import { queryString, type SearchParams } from "../_lib/page-data";

export const metadata = { title: "Cancellations report" };

export default function CancellationsReportPage({ searchParams }: { searchParams: SearchParams }) {
  return (
    <ReportPageShell
      searchParams={searchParams}
      render={async (ctx) => {
        const [report, table] = await Promise.all([
          getCancellationsReport(ctx.db, {
            timezone: ctx.timezone,
            from: ctx.params.from,
            to: ctx.params.to,
          }),
          buildReportTable(ctx.db, "cancellations", {
            timezone: ctx.timezone,
            now: ctx.now,
            query: ctx.query,
          }),
        ]);
        const c = report.counts;
        return (
          <>
            <DateRangeForm
              path="/reports/cancellations"
              params={ctx.params}
              presets={ctx.presets}
            />
            <StatTiles
              tiles={[
                {
                  label: "Kept from deposits and fees",
                  value: formatAud(report.keptCents),
                  note: `${formatAud(report.refundedCents)} refunded on cancellations`,
                  lead: true,
                },
                {
                  label: "Rate",
                  value:
                    report.cancellationRatePct === null ? "—" : `${report.cancellationRatePct}%`,
                  note: `${c.total} of ${report.scheduledCount} appointments`,
                },
                { label: "No-shows", value: String(c.no_show) },
                { label: "Late cancels", value: String(c.late_cancelled) },
                {
                  label: "Cancelled in time",
                  value: String(c.cancelled_by_client + c.cancelled_by_staff),
                },
              ]}
            />
            <DataTable
              table={table}
              exportQuery={queryString(ctx.params)}
              note="Appointments in the range that did not go ahead. Kept = deposit (for late cancels and no-shows) plus any fee, less refunds."
            />
          </>
        );
      }}
    />
  );
}
