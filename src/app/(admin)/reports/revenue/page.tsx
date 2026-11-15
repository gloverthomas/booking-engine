import { buildReportTable, formatAud, getRevenueReport } from "@/server/reports";
import { DataTable } from "../_components/DataTable";
import { DateRangeForm } from "../_components/DateRangeForm";
import { ReportPageShell } from "../_components/ReportPageShell";
import { RevenueChart } from "../_components/RevenueChart";
import { StatTiles } from "../_components/StatTiles";
import { queryString, type SearchParams } from "../_lib/page-data";
import { Card } from "../ui-shim";

export const metadata = { title: "Revenue report" };

export default function RevenueReportPage({ searchParams }: { searchParams: SearchParams }) {
  return (
    <ReportPageShell
      searchParams={searchParams}
      render={async (ctx) => {
        const [report, table] = await Promise.all([
          getRevenueReport(ctx.db, {
            timezone: ctx.timezone,
            from: ctx.params.from,
            to: ctx.params.to,
            granularity: ctx.params.granularity,
            groupBy: ctx.params.groupBy,
            staffId: ctx.staffId,
          }),
          buildReportTable(ctx.db, "revenue", ctx.tableContext),
        ]);
        const t = report.totals;
        return (
          <>
            <DateRangeForm
              path="/reports/revenue"
              params={ctx.params}
              presets={ctx.presets}
              granularity
              groupBy
              staffOptions={ctx.staffOptions}
            />
            <StatTiles
              tiles={[
                {
                  label: "Net revenue",
                  value: formatAud(t.netCents),
                  note: "Received minus refunds",
                  lead: true,
                },
                {
                  label: "Gross received",
                  value: formatAud(t.grossCents),
                  note: `${t.paymentCount} payments`,
                },
                { label: "Deposits", value: formatAud(t.depositsCents) },
                { label: "Balances", value: formatAud(t.balancesCents) },
                { label: "Refunds", value: formatAud(t.refundsCents) },
                {
                  label: "Fees kept",
                  value: formatAud(t.feesKeptCents),
                  note: "Forfeited deposits and no-show fees",
                },
              ]}
            />
            <Card aria-labelledby="rev-chart">
              <div className="rpt-card-head">
                <div>
                  <h2 id="rev-chart">Money received by {ctx.params.granularity}</h2>
                  <p className="rpt-sub">
                    Counted on the day each payment was recorded ({ctx.timezone}). Pending and
                    failed payments are left out. Refunds are not drawn; see the table.
                  </p>
                </div>
              </div>
              <RevenueChart series={report.series} granularity={ctx.params.granularity} />
            </Card>
            <DataTable
              table={table}
              exportQuery={queryString(ctx.params)}
              note={
                ctx.params.groupBy === "service"
                  ? "Payments on multi-service bookings are split by each service's share of the price."
                  : undefined
              }
            />
          </>
        );
      }}
    />
  );
}
