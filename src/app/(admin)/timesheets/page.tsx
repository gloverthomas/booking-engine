import Link from "next/link";
import { connection } from "next/server";
import { Suspense } from "react";
import { DateTime } from "luxon";
import { asc, eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { location } from "@/db/schema";
import {
  Alert,
  Badge,
  EmptyState,
  PageHeader,
  Table,
  TBody,
  TD,
  TH,
  THead,
  TR,
} from "@/components/ui";
import { buttonClasses } from "@/components/ui";
import { requireAccess } from "@/server/auth/access";
import { can } from "@/server/auth/permissions";
import { loadBusinessContext } from "@/server/reports/context";
import { isTimesheetError } from "@/server/timesheets/errors";
import { timesheetQuerySchema } from "@/server/timesheets/schemas";
import { staffIdsFor, timesheetScopeFor } from "@/server/timesheets/scope";
import {
  formatClockTime,
  formatDayLabel,
  formatDuration,
  formatSignedDuration,
  formatWeekLabel,
  toLocalInputValue,
  weekStartOf,
} from "@/server/timesheets/time";
import {
  getWeeklyTimesheets,
  type TimeEntryStatus,
  type TimesheetEntryView,
  type WeeklyTimesheet,
} from "@/server/timesheets/weekly";
import { ApproveButton } from "./_components/ApproveButton";
import { EntryDialog } from "./_components/EntryDialog";

export const metadata = { title: "Timesheets" };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

const STATUS: Record<TimeEntryStatus, { label: string; tone: "info" | "warning" | "success" }> = {
  open: { label: "Clocked in", tone: "info" },
  pending: { label: "Awaiting approval", tone: "warning" },
  approved: { label: "Approved", tone: "success" },
};

export default function TimesheetsPage({ searchParams }: { searchParams: SearchParams }) {
  return (
    <Suspense
      fallback={
        <p role="status" className="py-10 text-ink-muted">
          Loading timesheets
        </p>
      }
    >
      <Loaded searchParams={searchParams} />
    </Suspense>
  );
}

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

function weekHref(weekStart: string, staff: string | undefined): string {
  const q = new URLSearchParams({ week: weekStart });
  if (staff) q.set("staff", staff);
  return `/timesheets?${q.toString()}`;
}

async function Loaded({ searchParams }: { searchParams: SearchParams }) {
  await connection();
  const raw = await searchParams;
  const session = await requireAccess("timesheets.viewOwn");
  const db = getDb();
  const { timezone } = await loadBusinessContext(db);
  const now = new Date();
  const parsed = timesheetQuerySchema.safeParse({
    week: first(raw.week) || undefined,
    staff: first(raw.staff) || undefined,
  });
  let weekStart = weekStartOf(now, timezone);
  let notice: string | null = parsed.success
    ? null
    : "That link was not valid, so this week is shown.";
  try {
    if (parsed.success && parsed.data.week) weekStart = weekStartOf(parsed.data.week, timezone);
  } catch (error) {
    if (!isTimesheetError(error)) throw error;
    notice = error.message;
  }
  const requested = parsed.success ? parsed.data.staff : undefined;

  const scope = timesheetScopeFor(session.role, session.staffId);
  const ids = staffIdsFor(scope, requested);
  const sheets = await getWeeklyTimesheets(db, {
    timezone,
    weekStart,
    ...(ids === "all" ? {} : { staffIds: ids }),
  });
  const locations = await db
    .select({ id: location.id, name: location.name })
    .from(location)
    .where(eq(location.active, true))
    .orderBy(asc(location.sortOrder), asc(location.name));
  const canApprove = can(session.role, "timesheets.approve");
  const prev =
    DateTime.fromISO(weekStart, { zone: "utc" }).minus({ weeks: 1 }).toISODate() ?? weekStart;
  const next =
    DateTime.fromISO(weekStart, { zone: "utc" }).plus({ weeks: 1 }).toISODate() ?? weekStart;
  const thisWeek = weekStartOf(now, timezone);
  const viewing = ids === "all" ? undefined : requested;
  const exportQuery = new URLSearchParams({
    week: weekStart,
    ...(viewing ? { staff: viewing } : {}),
  });

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        eyebrow="Time and attendance"
        title="Timesheets"
        description="Hours worked from clock in and out, against the hours rostered. Hours only: pay is worked out elsewhere."
        actions={
          <>
            <a
              className={buttonClasses({ variant: "secondary" })}
              href={`/timesheets/export?${exportQuery.toString()}&kind=summary`}
              download=""
            >
              Export summary CSV
            </a>
            <a
              className={buttonClasses({ variant: "secondary" })}
              href={`/timesheets/export?${exportQuery.toString()}&kind=entries`}
              download=""
            >
              Export entries CSV
            </a>
          </>
        }
      />
      {notice ? <Alert tone="warning">{notice}</Alert> : null}
      <nav aria-label="Week" className="flex flex-wrap items-center gap-2">
        <Link
          className={buttonClasses({ variant: "secondary", size: "sm" })}
          href={weekHref(prev, viewing)}
        >
          Previous week
        </Link>
        <Link
          className={buttonClasses({ variant: "secondary", size: "sm" })}
          href={weekHref(thisWeek, viewing)}
          aria-current={weekStart === thisWeek ? "page" : undefined}
        >
          This week
        </Link>
        <Link
          className={buttonClasses({ variant: "secondary", size: "sm" })}
          href={weekHref(next, viewing)}
        >
          Next week
        </Link>
        <h2 className="ml-2 text-lg font-semibold">{formatWeekLabel(weekStart)}</h2>
      </nav>

      {scope.kind === "none" ? (
        <EmptyState
          title="No timesheet yet"
          description="Your login is not linked to a staff profile. Ask the owner to link it under Staff."
        />
      ) : ids === "all" ? (
        <TeamTable sheets={sheets} weekStart={weekStart} canApprove={canApprove} />
      ) : sheets.length === 0 ? (
        <EmptyState title="Nobody to show" description="That team member was not found." />
      ) : (
        <>
          {scope.kind === "all" ? (
            <p>
              <Link className="underline" href={weekHref(weekStart, undefined)}>
                Back to the whole team
              </Link>
            </p>
          ) : null}
          <PersonWeek
            sheet={sheets[0]}
            timezone={timezone}
            canApprove={canApprove}
            locations={locations}
            today={DateTime.fromJSDate(now, { zone: timezone }).toISODate() ?? weekStart}
          />
        </>
      )}
    </div>
  );
}

function Diff({ minutes }: { minutes: number | null }) {
  if (minutes === null) return <span className="text-ink-subtle">Not yet</span>;
  const word = minutes > 0 ? "over" : minutes < 0 ? "under" : "on roster";
  return (
    <span>
      {formatSignedDuration(minutes)} <span className="text-ink-muted">({word})</span>
    </span>
  );
}

function TeamTable({
  sheets,
  weekStart,
  canApprove,
}: {
  sheets: WeeklyTimesheet[];
  weekStart: string;
  canApprove: boolean;
}) {
  if (sheets.length === 0) return <EmptyState title="No team members yet" />;
  return (
    <Table caption={`Team timesheets for the week starting ${weekStart}`}>
      <THead>
        <TR>
          <TH>Person</TH>
          <TH className="text-right">Worked</TH>
          <TH className="text-right">Rostered</TH>
          <TH>Difference</TH>
          <TH>Approval</TH>
          <TH>
            <span className="sr-only">Actions</span>
          </TH>
        </TR>
      </THead>
      <TBody>
        {sheets.map((s) => {
          const pendingIds = s.days.flatMap((d) =>
            d.entries.filter((e) => e.status === "pending").map((e) => e.id),
          );
          return (
            <TR key={s.staffId}>
              <TD className="font-semibold">
                {s.staffName}
                {s.hasOpenEntry ? (
                  <Badge tone="info" className="ml-2">
                    Clocked in
                  </Badge>
                ) : null}
              </TD>
              <TD className="text-right tabular-nums">{formatDuration(s.workedMinutes)}</TD>
              <TD className="text-right tabular-nums">{formatDuration(s.rosteredMinutes)}</TD>
              <TD className="tabular-nums">
                <Diff minutes={s.differenceMinutes} />
              </TD>
              <TD>
                {s.pendingCount > 0 ? (
                  <Badge tone="warning">{s.pendingCount} awaiting</Badge>
                ) : s.approvedCount > 0 ? (
                  <Badge tone="success">All approved</Badge>
                ) : (
                  <span className="text-ink-subtle">No entries</span>
                )}
              </TD>
              <TD>
                <div className="flex flex-wrap items-center gap-2">
                  <Link
                    className={buttonClasses({ variant: "ghost", size: "sm" })}
                    href={weekHref(weekStart, s.staffId)}
                  >
                    View
                  </Link>
                  {canApprove && pendingIds.length > 0 ? (
                    <ApproveButton entryIds={pendingIds} label={`Approve ${pendingIds.length}`} />
                  ) : null}
                </div>
              </TD>
            </TR>
          );
        })}
      </TBody>
    </Table>
  );
}

function entryTimes(e: TimesheetEntryView, timezone: string): string {
  const start = formatClockTime(e.clockIn, timezone);
  return e.clockOut
    ? `${start} to ${formatClockTime(e.clockOut, timezone)}`
    : `${start}, still clocked in`;
}

function PersonWeek({
  sheet,
  timezone,
  canApprove,
  locations,
  today,
}: {
  sheet: WeeklyTimesheet;
  timezone: string;
  canApprove: boolean;
  locations: Array<{ id: string; name: string }>;
  today: string;
}) {
  const pendingIds = sheet.days.flatMap((d) =>
    d.entries.filter((e) => e.status === "pending").map((e) => e.id),
  );
  const defaultDate = sheet.days.find((d) => d.date <= today)?.date ?? sheet.weekStart;
  return (
    <section aria-labelledby="person-heading" className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 id="person-heading" className="text-xl font-semibold">
            {sheet.staffName}
          </h2>
          <dl className="mt-2 flex flex-wrap gap-x-8 gap-y-1">
            <div>
              <dt className="eyebrow">Worked</dt>
              <dd className="tabular-nums">{formatDuration(sheet.workedMinutes)}</dd>
            </div>
            <div>
              <dt className="eyebrow">Rostered</dt>
              <dd className="tabular-nums">{formatDuration(sheet.rosteredMinutes)}</dd>
            </div>
            <div>
              <dt className="eyebrow">Difference so far</dt>
              <dd className="tabular-nums">
                <Diff minutes={sheet.differenceMinutes} />
              </dd>
            </div>
          </dl>
        </div>
        {canApprove ? (
          <div className="flex gap-2">
            <EntryDialog
              mode="add"
              staffId={sheet.staffId}
              defaultDate={defaultDate}
              locations={locations}
            />
            {pendingIds.length > 0 ? (
              <ApproveButton
                entryIds={pendingIds}
                label={`Approve ${pendingIds.length}`}
                size="md"
              />
            ) : null}
          </div>
        ) : null}
      </div>
      <Table caption={`${sheet.staffName}, week starting ${sheet.weekStart}`}>
        <THead>
          <TR>
            <TH>Day</TH>
            <TH>Entries</TH>
            <TH className="text-right">Worked</TH>
            <TH className="text-right">Rostered</TH>
            <TH>Difference</TH>
          </TR>
        </THead>
        <TBody>
          {sheet.days.map((day) => (
            <TR key={day.date}>
              <TD className="whitespace-nowrap font-semibold align-top">
                {formatDayLabel(day.date)}
              </TD>
              <TD>
                {day.entries.length === 0 ? (
                  <span className="text-ink-subtle">No time recorded</span>
                ) : (
                  <ul className="flex flex-col gap-2">
                    {day.entries.map((e) => (
                      <li key={e.id} className="flex flex-wrap items-center gap-2">
                        <span className="tabular-nums">{entryTimes(e, timezone)}</span>
                        {e.breakMinutes > 0 ? (
                          <span className="text-ink-muted">{e.breakMinutes}m break</span>
                        ) : null}
                        {e.locationName ? (
                          <span className="text-ink-muted">{e.locationName}</span>
                        ) : null}
                        {e.source === "manual" ? <Badge>Added by hand</Badge> : null}
                        <Badge tone={STATUS[e.status].tone}>{STATUS[e.status].label}</Badge>
                        {e.note ? <span className="text-ink-muted">{e.note}</span> : null}
                        {canApprove ? (
                          <span className="flex gap-1">
                            <EntryDialog
                              mode="edit"
                              staffId={e.staffId}
                              defaultDate={day.date}
                              locations={locations}
                              entry={{
                                id: e.id,
                                clockIn: toLocalInputValue(e.clockIn, timezone),
                                clockOut: e.clockOut
                                  ? toLocalInputValue(e.clockOut, timezone)
                                  : null,
                                breakMinutes: e.breakMinutes,
                                locationId: e.locationId,
                                note: e.note,
                              }}
                            />
                            {e.status === "pending" ? (
                              <ApproveButton entryIds={[e.id]} label="Approve" />
                            ) : null}
                          </span>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                )}
              </TD>
              <TD className="text-right tabular-nums align-top">
                {formatDuration(day.workedMinutes)}
              </TD>
              <TD className="text-right tabular-nums align-top">
                {formatDuration(day.rosteredMinutes)}
              </TD>
              <TD className="tabular-nums align-top">
                <Diff minutes={day.differenceMinutes} />
              </TD>
            </TR>
          ))}
        </TBody>
      </Table>
    </section>
  );
}
