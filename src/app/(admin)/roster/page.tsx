import { PageBoundary } from "@/components/admin/shell/page-boundary";
import type { Metadata } from "next";
import { DateTime } from "luxon";
import { getDb } from "@/db/client";
import { EmptyState } from "@/components/ui/empty-state";
import { ButtonLink } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/page-header";
import { Select } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { getBusiness } from "@/server/admin-foundation/business";
import { listLocations, listStaff } from "@/server/admin-foundation/catalog";
import { getWeeklyHours, listTimeBlocks, toLocalInputValue } from "@/server/admin-foundation/hours";
import { requireOwner } from "@/server/auth";
import { TimeOffManager } from "./_components/time-off-manager";
import { WeeklyHoursEditor } from "./_components/weekly-hours-editor";

export const metadata: Metadata = { title: "Hours" };

type SearchParams = Promise<{ [key: string]: string | string[] | undefined }>;

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export default function HoursPage({ searchParams }: { searchParams: SearchParams }) {
  return (
    <PageBoundary>
      <HoursBody searchParams={searchParams} />
    </PageBoundary>
  );
}

async function HoursBody({ searchParams }: { searchParams: SearchParams }) {
  await requireOwner();
  const params = await searchParams;
  const db = getDb();
  const [biz, staff, locations] = await Promise.all([
    getBusiness(db),
    listStaff(db),
    listLocations(db),
  ]);
  const activeStaff = staff.filter((s) => s.active);

  if (activeStaff.length === 0 || locations.length === 0) {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader eyebrow="Hours" title="Availability" />
        <EmptyState
          title={locations.length === 0 ? "Add a location first" : "No stylist yet"}
          description="Weekly hours are set per stylist and location."
          action={
            locations.length === 0 ? (
              <ButtonLink href="/catalog/locations/new">Add a location</ButtonLink>
            ) : undefined
          }
        />
      </div>
    );
  }

  const selectedStaff = activeStaff.find((s) => s.id === first(params.staff)) ?? activeStaff[0];
  const selectedLocation = locations.find((l) => l.id === first(params.location)) ?? locations[0];
  if (!selectedStaff || !selectedLocation) return null;

  const [week, blocks] = await Promise.all([
    getWeeklyHours(db, selectedStaff.id, selectedLocation.id),
    listTimeBlocks(db),
  ]);

  const now = DateTime.now().setZone(biz.timezone);
  const format = (d: Date) =>
    DateTime.fromJSDate(d, { zone: biz.timezone }).toFormat("ccc d LLL, h:mm a");
  const defaultStart = now.plus({ days: 1 }).set({ hour: 9, minute: 0 });
  const defaultEnd = now.plus({ days: 1 }).set({ hour: 17, minute: 0 });

  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        eyebrow="Hours"
        title="Availability"
        description={`When ${selectedStaff.name} works at each location, plus time off. Business timezone: ${biz.timezone}.`}
      />

      {activeStaff.length > 1 || locations.length > 1 ? (
        <form method="get" className="flex flex-wrap items-end gap-3">
          {activeStaff.length > 1 ? (
            <Select
              label="Stylist"
              name="staff"
              defaultValue={selectedStaff.id}
              wrapperClassName="min-w-48 flex-1 sm:flex-none"
            >
              {activeStaff.map((s) => (
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
            {locations.map((l) => (
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

      <WeeklyHoursEditor
        key={`${selectedStaff.id}:${selectedLocation.id}`}
        staffId={selectedStaff.id}
        locationId={selectedLocation.id}
        staffName={selectedStaff.name}
        locationName={selectedLocation.name}
        initialWeek={week}
      />

      <TimeOffManager
        staff={activeStaff.map((s) => ({ id: s.id, name: s.name }))}
        blocks={blocks.map((b) => ({
          id: b.id,
          staffName: b.staffName,
          label: `${format(b.start)} to ${format(b.end)}`,
          reason: b.reason,
        }))}
        defaultStaffId={selectedStaff.id}
        defaultStart={toLocalInputValue(defaultStart.toJSDate(), biz.timezone)}
        defaultEnd={toLocalInputValue(defaultEnd.toJSDate(), biz.timezone)}
      />
    </div>
  );
}
