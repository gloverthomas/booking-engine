import Link from "next/link";
import {
  buildReportTable,
  formatAud,
  getBookingsReport,
  getCancellationsReport,
  getClientsReport,
  getOutstandingReport,
  getRevenueReport,
} from "@/server/reports";
import { BarList } from "./_components/BarList";
import { DataTable } from "./_components/DataTable";
import { DateRangeForm } from "./_components/DateRangeForm";
import { ReportPageShell } from "./_components/ReportPageShell";
import { RevenueChart } from "./_components/RevenueChart";
import { StatTiles } from "./_components/StatTiles";
import { queryString, type SearchParams } from "./_lib/page-data";
import { Card } from "./ui-shim";

export const metadata = { title: "Reports" };

const pct = (n: number | null): string => (n === null ? "—" : `${n}%`);

export default function ReportsOverviewPage({ searchParams }: { searchParams: SearchParams }) {
  return (
    <ReportPageShell
      searchParams={searchParams}
      render={async (ctx) => {
        const range = { timezone: ctx.timezone, from: ctx.params.from, to: ctx.params.to };
        const [revenue, bookings, cancellations, clients, outstanding, top] = await Promise.all([
          getRevenueReport(ctx.db, {
            ...range,
            granularity: ctx.params.granularity,
            groupBy: "none",
          }),
          getBookingsReport(ctx.db, range),
          getCancellationsReport(ctx.db, range),
          getClientsReport(ctx.db, { ...range, now: ctx.now }),
          getOutstandingReport(ctx.db, { now: ctx.now }),
          buildReportTable(ctx.db, "top-clients", {
            timezone: ctx.timezone,
            now: ctx.now,
            query: ctx.query,
          }),
        ]);
        const qs = queryString(ctx.params);
        const t = revenue.totals;
        return (
          <>
            <DateRangeForm path="/reports" params={ctx.params} presets={ctx.presets} granularity />
            <StatTiles
              tiles={[
                {
                  label: "Net revenue",
                  value: formatAud(t.netCents),
                  note: `${formatAud(t.grossCents)} received, ${formatAud(t.refundsCents)} refunded`,
                  lead: true,
                },
                {
                  label: "Appointments",
                  value: String(bookings.bookedCount),
                  note: `${bookings.bookedHours} booked hours`,
                },
                {
                  label: "Utilisation",
                  value: pct(bookings.utilisationPct),
                  note: `of ${bookings.availableHours} open hours`,
                },
                {
                  label: "Cancel and no-show rate",
                  value: pct(cancellations.cancellationRatePct),
                  note: `${formatAud(cancellations.keptCents)} kept`,
                },
                {
                  label: "New clients",
                  value: String(clients.newClients),
                  note: `${clients.returningClients} returning`,
                },
                {
                  label: "Balances overdue",
                  value: formatAud(outstanding.overdueCents),
                  note: `${outstanding.overdueCount} appointment${outstanding.overdueCount === 1 ? "" : "s"}`,
                },
              ]}
            />
            <Card aria-labelledby="overview-revenue">
              <div className="rpt-card-head">
                <div>
                  <h2 id="overview-revenue">Money received</h2>
                  <p className="rpt-sub">
                    By {ctx.params.granularity}, on the day each payment was recorded.
                  </p>
                </div>
                <Link href={`/reports/revenue?${qs}`}>Revenue detail</Link>
              </div>
              <RevenueChart series={revenue.series} granularity={ctx.params.granularity} />
            </Card>
            <div className="rpt-grid-2">
              <Card aria-labelledby="overview-busy">
                <div className="rpt-card-head">
                  <h2 id="overview-busy">Busiest days</h2>
                  <Link href={`/reports/bookings?${qs}`}>Bookings detail</Link>
                </div>
                <BarList
                  label="Appointments by weekday"
                  rows={[...bookings.byWeekday.slice(1), bookings.byWeekday[0]].map((w) => ({
                    label: w.label,
                    value: w.bookings,
                    text: String(w.bookings),
                  }))}
                />
              </Card>
              <DataTable table={{ ...top, rows: top.rows.slice(0, 5) }} exportQuery={qs} />
            </div>
          </>
        );
      }}
    />
  );
}
