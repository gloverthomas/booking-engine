import { buildReportTable, getBookingsReport } from "@/server/reports";
import { BarList } from "../_components/BarList";
import { DataTable } from "../_components/DataTable";
import { DateRangeForm } from "../_components/DateRangeForm";
import { ReportPageShell } from "../_components/ReportPageShell";
import { StatTiles } from "../_components/StatTiles";
import { queryString, type SearchParams } from "../_lib/page-data";
import { Card } from "../ui-shim";

export const metadata = { title: "Bookings report" };

export default function BookingsReportPage({ searchParams }: { searchParams: SearchParams }) {
  return (
    <ReportPageShell
      searchParams={searchParams}
      render={async (ctx) => {
        const tableCtx = ctx.tableContext;
        const [report, utilisation, byStaff, weekdays, hours, byDay] = await Promise.all([
          getBookingsReport(ctx.db, {
            timezone: ctx.timezone,
            from: ctx.params.from,
            to: ctx.params.to,
            staffId: ctx.staffId,
          }),
          buildReportTable(ctx.db, "utilisation", tableCtx),
          buildReportTable(ctx.db, "utilisation-by-staff", tableCtx),
          buildReportTable(ctx.db, "busiest-weekdays", tableCtx),
          buildReportTable(ctx.db, "busiest-hours", tableCtx),
          buildReportTable(ctx.db, "bookings-by-day", tableCtx),
        ]);
        const qs = queryString(ctx.params);
        const status = report.statusCounts;
        return (
          <>
            <DateRangeForm
              path="/reports/bookings"
              params={ctx.params}
              presets={ctx.presets}
              staffOptions={ctx.staffOptions}
            />
            <StatTiles
              tiles={[
                {
                  label: "Utilisation",
                  value: report.utilisationPct === null ? "—" : `${report.utilisationPct}%`,
                  note: `${report.bookedHours} booked of ${report.availableHours} open hours`,
                  lead: true,
                },
                {
                  label: "Appointments",
                  value: String(report.bookedCount),
                  note: "Confirmed and completed",
                },
                { label: "Completed", value: String(status.completed) },
                { label: "Upcoming", value: String(status.confirmed) },
                {
                  label: "Not kept",
                  value: String(
                    status.cancelled_by_client +
                      status.cancelled_by_staff +
                      status.late_cancelled +
                      status.no_show,
                  ),
                  note: "Cancelled, late cancelled, no-show",
                },
              ]}
            />
            <div className="rpt-grid-2">
              <Card aria-labelledby="util-chart">
                <h2 id="util-chart">Utilisation by location</h2>
                <p className="rpt-sub">Booked hours as a share of open hours, after time off.</p>
                <BarList
                  label="Utilisation by location"
                  max={100}
                  rows={report.byLocation.map((l) => ({
                    label: l.locationName,
                    value: l.utilisationPct ?? 0,
                    text: l.utilisationPct === null ? "—" : `${l.utilisationPct}%`,
                  }))}
                />
              </Card>
              <Card aria-labelledby="weekday-chart">
                <h2 id="weekday-chart">Busiest days</h2>
                <p className="rpt-sub">Appointments by day of the week.</p>
                <BarList
                  label="Appointments by weekday"
                  rows={weekdays.rows.map((r) => {
                    const row = r as { label: string; bookings: number };
                    return { label: row.label, value: row.bookings, text: String(row.bookings) };
                  })}
                />
              </Card>
              <Card aria-labelledby="hour-chart">
                <h2 id="hour-chart">Busiest start times</h2>
                <p className="rpt-sub">Appointments by the hour they start.</p>
                <BarList
                  label="Appointments by start hour"
                  rows={hours.rows.map((r) => {
                    const row = r as { label: string; bookings: number };
                    return { label: row.label, value: row.bookings, text: String(row.bookings) };
                  })}
                />
              </Card>
            </div>
            <DataTable table={byStaff} exportQuery={qs} />
            <DataTable table={utilisation} exportQuery={qs} />
            <DataTable table={weekdays} exportQuery={qs} />
            <DataTable table={hours} exportQuery={qs} />
            <DataTable table={byDay} exportQuery={qs} />
          </>
        );
      }}
    />
  );
}
