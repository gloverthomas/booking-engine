import { buildReportTable, formatAud, getOutstandingReport } from "@/server/reports";
import { DataTable } from "../_components/DataTable";
import { ReportPageShell } from "../_components/ReportPageShell";
import { StatTiles } from "../_components/StatTiles";
import type { SearchParams } from "../_lib/page-data";

export const metadata = { title: "Outstanding balances" };

export default function OutstandingReportPage({ searchParams }: { searchParams: SearchParams }) {
  return (
    <ReportPageShell
      access="all"
      searchParams={searchParams}
      render={async (ctx) => {
        const [report, table] = await Promise.all([
          getOutstandingReport(ctx.db, { now: ctx.now }),
          buildReportTable(ctx.db, "outstanding", ctx.tableContext),
        ]);
        return (
          <>
            <StatTiles
              tiles={[
                {
                  label: "Overdue",
                  value: formatAud(report.overdueCents),
                  note: `${report.overdueCount} appointment${report.overdueCount === 1 ? "" : "s"} done, balance unpaid`,
                  lead: true,
                },
                {
                  label: "Due at the appointment",
                  value: formatAud(report.upcomingCents),
                  note: `${report.upcomingCount} upcoming`,
                },
              ]}
            />
            <DataTable
              table={table}
              note="As of now, not tied to the date range. Deposits and balances received count towards the total; no-show fees do not."
              emptyMessage="Nothing is owing."
            />
          </>
        );
      }}
    />
  );
}
