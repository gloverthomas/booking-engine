import { buildReportTable, getClientsReport } from "@/server/reports";
import { DataTable } from "../_components/DataTable";
import { DateRangeForm } from "../_components/DateRangeForm";
import { ReportPageShell } from "../_components/ReportPageShell";
import { StatTiles } from "../_components/StatTiles";
import { queryString, type SearchParams } from "../_lib/page-data";

export const metadata = { title: "Clients report" };

export default function ClientsReportPage({ searchParams }: { searchParams: SearchParams }) {
  return (
    <ReportPageShell
      searchParams={searchParams}
      render={async (ctx) => {
        const tableCtx = { timezone: ctx.timezone, now: ctx.now, query: ctx.query };
        const [report, top, lapsed] = await Promise.all([
          getClientsReport(ctx.db, {
            timezone: ctx.timezone,
            from: ctx.params.from,
            to: ctx.params.to,
            now: ctx.now,
          }),
          buildReportTable(ctx.db, "top-clients", tableCtx),
          buildReportTable(ctx.db, "lapsed-clients", tableCtx),
        ]);
        const qs = queryString(ctx.params);
        return (
          <>
            <DateRangeForm path="/reports/clients" params={ctx.params} presets={ctx.presets} />
            <StatTiles
              tiles={[
                {
                  label: "Clients seen",
                  value: String(report.activeClients),
                  note: `${report.newClients} new, ${report.returningClients} returning`,
                  lead: true,
                },
                {
                  label: "Rebook rate",
                  value: report.rebook.ratePct === null ? "—" : `${report.rebook.ratePct}%`,
                  note:
                    report.rebook.eligibleVisits === 0
                      ? `No visits yet old enough to judge (${report.rebook.windowDays}-day window)`
                      : `${report.rebook.rebookedVisits} of ${report.rebook.eligibleVisits} visits rebooked within ${report.rebook.windowDays} days`,
                },
                {
                  label: "Lapsed clients",
                  value: String(report.lapsed.total),
                  note: `No visit in ${report.lapsed.thresholdDays}+ days and nothing booked`,
                },
              ]}
            />
            <DataTable
              table={top}
              exportQuery={qs}
              note="Money received in the range, less refunds."
            />
            <DataTable
              table={lapsed}
              exportQuery={qs}
              note="Right now, whatever range is chosen. Blocked and merged clients are left out."
            />
          </>
        );
      }}
    />
  );
}
