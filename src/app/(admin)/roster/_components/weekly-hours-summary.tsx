import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { WEEKDAYS_MON_FIRST, type Week } from "@/server/admin-foundation/week";
import { formatMinuteRange } from "@/server/roster/format";

/** Read-only view of one stylist's recurring week, for people who may see but not edit the roster. */
export function WeeklyHoursSummary({
  staffName,
  locationName,
  week,
}: {
  staffName: string;
  locationName: string;
  week: Week;
}) {
  return (
    <Card aria-labelledby="weekly-hours-summary-title">
      <CardHeader
        eyebrow={`${staffName} · ${locationName}`}
        title={<span id="weekly-hours-summary-title">Weekly hours</span>}
      />
      <CardBody>
        <dl className="divide-y divide-line">
          {WEEKDAYS_MON_FIRST.map((day) => {
            const ranges = week[day.index] ?? [];
            return (
              <div key={day.index} className="grid gap-1 py-3 sm:grid-cols-[8rem_1fr] sm:gap-6">
                <dt className="display text-lg">{day.short}</dt>
                <dd className="text-ink">
                  {ranges.length === 0
                    ? "Closed"
                    : ranges.map((r) => formatMinuteRange(r)).join(", ")}
                </dd>
              </div>
            );
          })}
        </dl>
      </CardBody>
    </Card>
  );
}
