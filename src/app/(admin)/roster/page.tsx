import type { Metadata } from "next";
import { DateTime } from "luxon";
import { getDb } from "@/db/client";
import { PageBoundary } from "@/components/admin/shell/page-boundary";
import { Button, ButtonLink } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { Select } from "@/components/ui/select";
import { getBusiness } from "@/server/admin-foundation/business";
import { listLocations, listStaff } from "@/server/admin-foundation/catalog";
import { getWeeklyHours, listTimeBlocks, toLocalInputValue } from "@/server/admin-foundation/hours";
import { AccessDeniedError, requireAccess, type AccessSession } from "@/server/auth/access";
import { getRosterOverview, listExceptions, rosterAccessFor, weekStartOf } from "@/server/roster";
import { formatDayLabel, formatMinuteRange } from "@/server/roster/format";
import { DayExceptions, type ExceptionView } from "./_components/day-exceptions";
import { TimeOffManager } from "./_components/time-off-manager";
import { WeeklyHoursEditor } from "./_components/weekly-hours-editor";
import { WeeklyHoursSummary } from "./_components/weekly-hours-summary";
import { WhosWorking } from "./_components/whos-working";

export const metadata: Metadata = { title: "Roster" };

type SearchParams = Promise<{ [key: string]: string | string[] | undefined }>;

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** roster.viewAll sees everyone, roster.viewOwn only themselves; anyone else is turned away. */
async function requireRosterSession(): Promise<AccessSession> {
  try {
    return await requireAccess("roster.viewAll");
  } catch (error) {
    if (error instanceof AccessDeniedError) return requireAccess("roster.viewOwn");
    throw error;
  }
}

function rosterHref(params: { week: string; staff?: string; location?: string }): string {
  const query = new URLSearchParams({ week: params.week });
  if (params.staff) query.set("staff", params.staff);
  if (params.location) query.set("location", params.location);
  return `/roster?${query.toString()}`;
}

export default function RosterPage({ searchParams }: { searchParams: SearchParams }) {
  return (
    <PageBoundary>
      <RosterBody searchParams={searchParams} />
    </PageBoundary>
  );
}

async function RosterBody({ searchParams }: { searchParams: SearchParams }) {
  const session = await requireRosterSession();
  const access = rosterAccessFor(session.role);
  if (!access) throw new AccessDeniedError("roster.viewOwn");

  const params = await searchParams;
  const db = getDb();
  const [biz, allStaff, locations] = await Promise.all([
    getBusiness(db),
    listStaff(db),
    listLocations(db),
  ]);
  const activeLocations = locations.filter((l) => l.active);
  // A stylist (scope "own") only ever sees their own row, whatever the URL says.
  const visibleStaff = allStaff.filter(
    (s) => s.active && (access.scope === "all" || s.id === session.staffId),
  );
  const visibleIds = visibleStaff.map((s) => s.id);

  if (visibleStaff.length === 0 || activeLocations.length === 0) {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader eyebrow="Roster" title="Who’s working" />
        <EmptyState
          title={activeLocations.length === 0 ? "Add a location first" : "No roster to show"}
          description={
            access.scope === "own"
              ? "Your account is not linked to a stylist profile yet. Ask the owner to link it in Staff."
              : "Weekly hours are set per stylist and location."
          }
          action={
            activeLocations.length === 0 && access.canEdit ? (
              <ButtonLink href="/catalog/locations/new">Add a location</ButtonLink>
            ) : undefined
          }
        />
      </div>
    );
  }

  const zone = biz.timezone;
  const today = DateTime.now().setZone(zone).toISODate() as string;
  const weekStart = weekStartOf(first(params.week) ?? today);
  const previousWeek = DateTime.fromISO(weekStart, { zone: "utc" }).minus({ days: 7 }).toISODate();
  const nextWeek = DateTime.fromISO(weekStart, { zone: "utc" }).plus({ days: 7 }).toISODate();

  const selectedStaff = visibleStaff.find((s) => s.id === first(params.staff)) ?? visibleStaff[0];
  const selectedLocation =
    activeLocations.find((l) => l.id === first(params.location)) ?? activeLocations[0];
  if (!selectedStaff || !selectedLocation || !previousWeek || !nextWeek) return null;

  const [overview, week, exceptions, blocks] = await Promise.all([
    getRosterOverview(db, { weekOf: weekStart, staffIds: visibleIds }),
    getWeeklyHours(db, selectedStaff.id, selectedLocation.id),
    listExceptions(db, { fromDate: today, staffIds: visibleIds }),
    listTimeBlocks(db),
  ]);

  const formatTime = (d: Date) => DateTime.fromJSDate(d, { zone }).toFormat("ccc d LLL, h:mm a");
  const tomorrow = DateTime.now().setZone(zone).plus({ days: 1 });
  const exceptionViews: ExceptionView[] = exceptions.map((e) => ({
    id: e.id,
    staffName: e.staffName,
    dateLabel: formatDayLabel(e.date),
    kind: e.kind,
    where: e.locationName ?? "All locations",
    hours:
      e.kind === "custom" && e.startMinute !== null && e.endMinute !== null
        ? formatMinuteRange({ startMinute: e.startMinute, endMinute: e.endMinute })
        : null,
    note: e.note,
  }));

  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        eyebrow="Roster"
        title="Who’s working"
        description={`Hours by stylist and location, day exceptions and time off. Business timezone: ${zone}.`}
      />

      <WhosWorking
        overview={overview}
        today={today}
        navigation={
          <>
            <ButtonLink
              variant="secondary"
              size="sm"
              href={rosterHref({
                week: previousWeek,
                staff: selectedStaff.id,
                location: selectedLocation.id,
              })}
              aria-label="Previous week"
            >
              Previous
            </ButtonLink>
            <ButtonLink
              variant="secondary"
              size="sm"
              href={rosterHref({
                week: today,
                staff: selectedStaff.id,
                location: selectedLocation.id,
              })}
            >
              This week
            </ButtonLink>
            <ButtonLink
              variant="secondary"
              size="sm"
              href={rosterHref({
                week: nextWeek,
                staff: selectedStaff.id,
                location: selectedLocation.id,
              })}
              aria-label="Next week"
            >
              Next
            </ButtonLink>
          </>
        }
      />

      {visibleStaff.length > 1 || activeLocations.length > 1 ? (
        <form method="get" className="flex flex-wrap items-end gap-3">
          <input type="hidden" name="week" value={weekStart} />
          {visibleStaff.length > 1 ? (
            <Select
              label="Stylist"
              name="staff"
              defaultValue={selectedStaff.id}
              wrapperClassName="min-w-48 flex-1 sm:flex-none"
            >
              {visibleStaff.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </Select>
          ) : null}
          <Select
            label="Location"
            name="location"
            defaultValue={selectedLocation.id}
            wrapperClassName="min-w-56 flex-1 sm:flex-none"
          >
            {activeLocations.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </Select>
          <Button type="submit" variant="secondary">
            Show
          </Button>
        </form>
      ) : null}

      {access.canEdit ? (
        <WeeklyHoursEditor
          key={`${selectedStaff.id}:${selectedLocation.id}`}
          staffId={selectedStaff.id}
          locationId={selectedLocation.id}
          staffName={selectedStaff.name}
          locationName={selectedLocation.name}
          initialWeek={week}
        />
      ) : (
        <WeeklyHoursSummary
          staffName={selectedStaff.name}
          locationName={selectedLocation.name}
          week={week}
        />
      )}

      <DayExceptions
        staff={visibleStaff.map((s) => ({ id: s.id, name: s.name }))}
        locations={activeLocations.map((l) => ({ id: l.id, name: l.name }))}
        exceptions={exceptionViews}
        defaultStaffId={selectedStaff.id}
        today={today}
        canEdit={access.canEdit}
      />

      <TimeOffManager
        staff={visibleStaff.map((s) => ({ id: s.id, name: s.name }))}
        blocks={blocks
          .filter((b) => visibleIds.includes(b.staffId))
          .map((b) => ({
            id: b.id,
            staffName: b.staffName,
            label: `${formatTime(b.start)} to ${formatTime(b.end)}`,
            reason: b.reason,
          }))}
        defaultStaffId={selectedStaff.id}
        canEdit={access.canEdit}
        defaultStart={toLocalInputValue(tomorrow.set({ hour: 9, minute: 0 }).toJSDate(), zone)}
        defaultEnd={toLocalInputValue(tomorrow.set({ hour: 17, minute: 0 }).toJSDate(), zone)}
      />
    </div>
  );
}
