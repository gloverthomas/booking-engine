import { Badge } from "@/components/ui/badge";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import type { RosterDay, RosterOverview } from "@/server/roster";
import { formatDayLabel, formatMinuteRange } from "@/server/roster/format";

interface WhosWorkingProps {
  overview: RosterOverview;
  /** Local today, YYYY-MM-DD, to highlight the current column. */
  today: string;
  /** Shown in the card header: previous / this week / next links. */
  navigation: React.ReactNode;
}

function DayCell({ day, showLocation }: { day: RosterDay; showLocation: boolean }) {
  if (day.entries.length === 0 && !day.off) {
    return (
      <span className="text-ink-subtle">
        <span aria-hidden>-</span>
        <span className="sr-only">Not working</span>
      </span>
    );
  }
  return (
    <div className="flex flex-col gap-1.5">
      {day.entries.map((entry) => (
        <div key={entry.locationId} className="leading-snug">
          {showLocation ? (
            <p className="text-xs font-semibold uppercase tracking-[0.06em] text-ink-subtle">
              {entry.locationName}
            </p>
          ) : null}
          {entry.ranges.map((range) => (
            <p key={range.startMinute} className="font-semibold">
              {formatMinuteRange(range)}
            </p>
          ))}
          {entry.kind === "custom" ? <Badge tone="info">Custom hours</Badge> : null}
        </div>
      ))}
      {day.off ? (
        <div className="leading-snug">
          <Badge tone="warning">
            {day.off.everywhere || !showLocation
              ? "Day off"
              : `Off at ${day.off.locationNames.join(", ")}`}
          </Badge>
          {day.off.note ? <p className="mt-1 text-sm text-ink-muted">{day.off.note}</p> : null}
        </div>
      ) : null}
    </div>
  );
}

/** "Who's working": one row per stylist, one column per day, per-location hours after exceptions. */
export function WhosWorking({ overview, today, navigation }: WhosWorkingProps) {
  const showLocation = overview.locations.length > 1;
  return (
    <Card aria-labelledby="whos-working-title">
      <CardHeader
        eyebrow={`Week of ${formatDayLabel(overview.weekStart)}`}
        title={<span id="whos-working-title">Who&rsquo;s working</span>}
        actions={navigation}
      />
      <CardBody>
        {overview.rows.length === 0 ? (
          <EmptyState
            title="No stylists to show"
            description="Add a stylist in Staff, then set their weekly hours below."
          />
        ) : (
          <Table caption="Who is working each day this week, by stylist and location">
            <THead>
              <tr>
                <TH className="sticky left-0 bg-sunken">Stylist</TH>
                {overview.dates.map((date) => (
                  <TH
                    key={date}
                    aria-current={date === today ? "date" : undefined}
                    className={date === today ? "text-ink" : undefined}
                  >
                    {formatDayLabel(date)}
                    {date === today ? <span className="sr-only"> (today)</span> : null}
                  </TH>
                ))}
              </tr>
            </THead>
            <TBody>
              {overview.rows.map((row) => (
                <TR key={row.staffId}>
                  <TH
                    scope="row"
                    className="sticky left-0 bg-surface text-sm normal-case tracking-normal text-ink"
                  >
                    <span className="flex items-center gap-2">
                      <span
                        aria-hidden
                        className="size-3 shrink-0 rounded-full border border-line-strong"
                        style={row.colour ? { backgroundColor: row.colour } : undefined}
                      />
                      {row.name}
                    </span>
                  </TH>
                  {row.days.map((day) => (
                    <TD key={day.date} className="min-w-36 align-top">
                      <DayCell day={day} showLocation={showLocation} />
                    </TD>
                  ))}
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </CardBody>
    </Card>
  );
}
