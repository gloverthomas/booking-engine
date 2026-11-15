"use client";

import { useState, type FormEvent } from "react";
import { Plus, Trash2 } from "lucide-react";
import { useSubmit } from "@/components/admin/shell/use-submit";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { useToast } from "@/components/ui/toast";
import type { MinuteRange } from "@/server/admin-foundation/week";
import { removeExceptionAction, setCustomHoursAction, setDayOffAction } from "../actions";
import { TimeField } from "./time-field";

export interface ExceptionView {
  id: string;
  staffName: string;
  /** Already formatted, e.g. "Mon 2 Nov". */
  dateLabel: string;
  kind: "off" | "custom";
  /** Where it applies: a location name or "All locations". */
  where: string;
  /** Formatted hours for custom days, e.g. "10am to 12pm". */
  hours: string | null;
  note: string | null;
}

interface DayExceptionsProps {
  staff: Array<{ id: string; name: string }>;
  locations: Array<{ id: string; name: string }>;
  exceptions: ExceptionView[];
  defaultStaffId: string;
  /** Earliest date that can be chosen (local today, YYYY-MM-DD). */
  today: string;
  canEdit: boolean;
}

const ALL_LOCATIONS = "all";
const DEFAULT_RANGE: MinuteRange = { startMinute: 10 * 60, endMinute: 14 * 60 };

/** One-off changes to the weekly roster: a day off, or different hours for a single date. */
export function DayExceptions({
  staff,
  locations,
  exceptions,
  defaultStaffId,
  today,
  canEdit,
}: DayExceptionsProps) {
  const { pending, error, fieldErrors, submit } = useSubmit();
  const { toast } = useToast();
  const [staffId, setStaffId] = useState(defaultStaffId);
  const [date, setDate] = useState(today);
  const [kind, setKind] = useState<"off" | "custom">("off");
  const [locationId, setLocationId] = useState(ALL_LOCATIONS);
  const [ranges, setRanges] = useState<MinuteRange[]>([DEFAULT_RANGE]);
  const [note, setNote] = useState("");

  function warnAboutBookings(data: { conflictingBookings: number } | undefined) {
    if (data && data.conflictingBookings > 0) {
      toast({
        title: `${data.conflictingBookings} existing booking${data.conflictingBookings === 1 ? " is" : "s are"} outside these hours`,
        description: "They have not been moved or cancelled. Review them in Bookings.",
        tone: "info",
      });
    }
  }

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (kind === "off") {
      submit(
        () =>
          setDayOffAction({
            staffId,
            date,
            locationId: locationId === ALL_LOCATIONS ? null : locationId,
            note,
          }),
        { success: "Day off saved", onSuccess: warnAboutBookings },
      );
      return;
    }
    const customLocation = locationId === ALL_LOCATIONS ? (locations[0]?.id ?? "") : locationId;
    submit(
      () => setCustomHoursAction({ staffId, date, locationId: customLocation, ranges, note }),
      {
        success: "Custom hours saved",
        onSuccess: warnAboutBookings,
      },
    );
  }

  return (
    <Card aria-labelledby="day-exceptions-title">
      <CardHeader
        eyebrow="One-off changes"
        title={<span id="day-exceptions-title">Day exceptions</span>}
      />
      <CardBody className="flex flex-col gap-6">
        {canEdit ? (
          <form onSubmit={onSubmit} noValidate className="grid gap-4 sm:grid-cols-2">
            {error ? (
              <Alert tone="danger" className="sm:col-span-2">
                {error}
              </Alert>
            ) : null}
            {staff.length > 1 ? (
              <Select
                label="Stylist"
                value={staffId}
                onChange={(e) => setStaffId(e.target.value)}
                error={fieldErrors.staffId}
              >
                {staff.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </Select>
            ) : null}
            <Input
              label="Date"
              type="date"
              required
              min={today}
              value={date}
              onChange={(e) => setDate(e.target.value)}
              error={fieldErrors.date}
            />
            <Select
              label="What changes"
              value={kind}
              onChange={(e) => setKind(e.target.value === "custom" ? "custom" : "off")}
            >
              <option value="off">Day off</option>
              <option value="custom">Different hours</option>
            </Select>
            <Select
              label="Where"
              value={locationId}
              onChange={(e) => setLocationId(e.target.value)}
              error={fieldErrors.locationId}
              hint={
                kind === "custom"
                  ? "Different hours apply at one location."
                  : "A day off can cover every location."
              }
            >
              {kind === "off" ? <option value={ALL_LOCATIONS}>All locations</option> : null}
              {locations.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </Select>

            {kind === "custom" ? (
              <fieldset className="flex flex-col gap-3 sm:col-span-2">
                <legend className="eyebrow mb-1">Hours that day</legend>
                {ranges.map((range, index) => (
                  <div key={index} className="flex flex-wrap items-center gap-2">
                    <TimeField
                      label={`Range ${index + 1} start`}
                      minutes={range.startMinute}
                      onChange={(startMinute) =>
                        setRanges((current) =>
                          current.map((r, i) => (i === index ? { ...r, startMinute } : r)),
                        )
                      }
                    />
                    <span aria-hidden className="text-ink-subtle">
                      to
                    </span>
                    <TimeField
                      label={`Range ${index + 1} end`}
                      minutes={range.endMinute}
                      onChange={(endMinute) =>
                        setRanges((current) =>
                          current.map((r, i) => (i === index ? { ...r, endMinute } : r)),
                        )
                      }
                    />
                    {ranges.length > 1 ? (
                      <Button
                        variant="ghost"
                        aria-label={`Remove range ${index + 1}`}
                        onClick={() =>
                          setRanges((current) => current.filter((_, i) => i !== index))
                        }
                      >
                        <Trash2 aria-hidden className="size-4" />
                      </Button>
                    ) : null}
                  </div>
                ))}
                {fieldErrors.ranges ? (
                  <p role="alert" className="text-sm text-danger">
                    {fieldErrors.ranges}
                  </p>
                ) : null}
                <div>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => {
                      const last = ranges[ranges.length - 1];
                      setRanges((current) => [
                        ...current,
                        last
                          ? {
                              startMinute: Math.min(last.endMinute + 60, 1380),
                              endMinute: Math.min(last.endMinute + 180, 1439),
                            }
                          : DEFAULT_RANGE,
                      ]);
                    }}
                  >
                    <Plus aria-hidden className="size-4" />
                    Add range
                  </Button>
                </div>
              </fieldset>
            ) : null}

            <Input
              label="Note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              error={fieldErrors.note}
              placeholder="Holiday, training, school pick-up…"
              hint="Only the team sees this."
              wrapperClassName="sm:col-span-2"
            />
            <div className="sm:col-span-2">
              <Button type="submit" loading={pending}>
                {kind === "off" ? "Save day off" : "Save hours"}
              </Button>
            </div>
          </form>
        ) : null}

        <div>
          <h3 className="eyebrow mb-2">Upcoming</h3>
          {exceptions.length === 0 ? (
            <EmptyState
              title="No exceptions"
              description="Days off and one-off hours show here until the day passes."
            />
          ) : (
            <ul className="divide-y divide-line rounded-card border border-line">
              {exceptions.map((exception) => (
                <ExceptionRow
                  key={exception.id}
                  exception={exception}
                  showStaff={staff.length > 1}
                  canEdit={canEdit}
                />
              ))}
            </ul>
          )}
        </div>
      </CardBody>
    </Card>
  );
}

function ExceptionRow({
  exception,
  showStaff,
  canEdit,
}: {
  exception: ExceptionView;
  showStaff: boolean;
  canEdit: boolean;
}) {
  const { pending, submit } = useSubmit();
  const detail = [showStaff ? exception.staffName : null, exception.where, exception.note]
    .filter(Boolean)
    .join(" · ");
  return (
    <li className="flex items-center justify-between gap-3 px-4 py-2">
      <div className="min-w-0">
        <p className="flex flex-wrap items-center gap-2 font-semibold">
          {exception.dateLabel}
          <Badge tone={exception.kind === "off" ? "warning" : "info"}>
            {exception.kind === "off" ? "Day off" : (exception.hours ?? "Custom hours")}
          </Badge>
        </p>
        <p className="truncate text-sm text-ink-muted">{detail}</p>
      </div>
      {canEdit ? (
        <Button
          variant="ghost"
          loading={pending}
          aria-label={`Remove exception on ${exception.dateLabel}`}
          onClick={() =>
            submit(() => removeExceptionAction({ id: exception.id }), {
              success: "Exception removed",
            })
          }
        >
          <Trash2 aria-hidden className="size-4" />
        </Button>
      ) : null}
    </li>
  );
}
