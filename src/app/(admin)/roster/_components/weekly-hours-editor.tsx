"use client";

import { useState } from "react";
import { Copy, Plus, Trash2 } from "lucide-react";
import { useSubmit } from "@/components/admin/shell/use-submit";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog } from "@/components/ui/dialog";
import { copyDay, WEEKDAYS_MON_FIRST, type Week } from "@/server/admin-foundation/week";
import { saveWeeklyHoursAction } from "../actions";
import { TimeField } from "./time-field";

interface WeeklyHoursEditorProps {
  staffId: string;
  locationId: string;
  staffName: string;
  locationName: string;
  initialWeek: Week;
}

const DEFAULT_RANGE = { startMinute: 9 * 60, endMinute: 17 * 60 };

/** Edits one stylist's recurring week at one location: several ranges per day, copy a day to others. */
export function WeeklyHoursEditor({
  staffId,
  locationId,
  staffName,
  locationName,
  initialWeek,
}: WeeklyHoursEditorProps) {
  const { pending, error, submit } = useSubmit();
  const [week, setWeek] = useState<Week>(initialWeek);
  const [copyFrom, setCopyFrom] = useState<number | null>(null);
  const [copyTargets, setCopyTargets] = useState<number[]>([]);

  function setDay(weekday: number, ranges: Week[number]) {
    setWeek((current) => current.map((day, index) => (index === weekday ? ranges : day)));
  }

  function openCopy(weekday: number) {
    setCopyFrom(weekday);
    setCopyTargets([]);
  }

  function confirmCopy() {
    if (copyFrom !== null) setWeek((current) => copyDay(current, copyFrom, copyTargets));
    setCopyFrom(null);
  }

  function save() {
    submit(() => saveWeeklyHoursAction({ staffId, locationId, week }), {
      success: "Hours saved",
    });
  }

  const copyDayLabel = WEEKDAYS_MON_FIRST.find((d) => d.index === copyFrom)?.label ?? "";

  return (
    <Card aria-labelledby="weekly-hours-title">
      <CardHeader
        eyebrow={`${staffName} · ${locationName}`}
        title={<span id="weekly-hours-title">Weekly hours</span>}
        actions={
          <Button onClick={save} loading={pending}>
            Save hours
          </Button>
        }
      />
      <CardBody className="flex flex-col">
        {error ? (
          <Alert tone="danger" className="mb-4">
            {error}
          </Alert>
        ) : null}
        <p className="mb-3 text-sm text-ink-muted">
          Times are local to the business timezone. A day with no ranges is closed at this location.
        </p>
        <ul className="divide-y divide-line">
          {WEEKDAYS_MON_FIRST.map((day) => {
            const ranges = week[day.index] ?? [];
            return (
              <li key={day.index} className="grid gap-3 py-4 sm:grid-cols-[8rem_1fr] sm:gap-6">
                <div className="flex items-start justify-between sm:block">
                  <p className="display text-lg">{day.short}</p>
                  <p className="text-sm text-ink-subtle sm:mt-1">{day.label}</p>
                </div>
                <div className="flex flex-col gap-3">
                  {ranges.length === 0 ? (
                    <p className="flex min-h-11 items-center text-ink-muted">Closed</p>
                  ) : (
                    ranges.map((range, index) => (
                      <div key={index} className="flex flex-wrap items-center gap-2">
                        <TimeField
                          label={`${day.label} range ${index + 1} start`}
                          minutes={range.startMinute}
                          onChange={(startMinute) =>
                            setDay(
                              day.index,
                              ranges.map((r, i) => (i === index ? { ...r, startMinute } : r)),
                            )
                          }
                        />
                        <span aria-hidden className="text-ink-subtle">
                          to
                        </span>
                        <TimeField
                          label={`${day.label} range ${index + 1} end`}
                          minutes={range.endMinute}
                          onChange={(endMinute) =>
                            setDay(
                              day.index,
                              ranges.map((r, i) => (i === index ? { ...r, endMinute } : r)),
                            )
                          }
                        />
                        <Button
                          variant="ghost"
                          aria-label={`Remove ${day.label} range ${index + 1}`}
                          onClick={() =>
                            setDay(
                              day.index,
                              ranges.filter((_, i) => i !== index),
                            )
                          }
                        >
                          <Trash2 aria-hidden className="size-4" />
                        </Button>
                      </div>
                    ))
                  )}
                  <div className="flex flex-wrap gap-2">
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => {
                        const last = ranges[ranges.length - 1];
                        const next = last
                          ? {
                              startMinute: Math.min(last.endMinute + 60, 1380),
                              endMinute: Math.min(last.endMinute + 180, 1439),
                            }
                          : DEFAULT_RANGE;
                        setDay(day.index, [...ranges, next]);
                      }}
                    >
                      <Plus aria-hidden className="size-4" />
                      {ranges.length === 0 ? "Add hours" : "Add range"}
                    </Button>
                    {ranges.length > 0 ? (
                      <Button variant="ghost" size="sm" onClick={() => openCopy(day.index)}>
                        <Copy aria-hidden className="size-4" />
                        Copy to…
                      </Button>
                    ) : null}
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      </CardBody>

      <Dialog
        open={copyFrom !== null}
        onClose={() => setCopyFrom(null)}
        title={`Copy ${copyDayLabel}`}
        description="Replaces the hours on the days you tick with these ranges."
        footer={
          <>
            <Button variant="secondary" onClick={() => setCopyFrom(null)}>
              Cancel
            </Button>
            <Button onClick={confirmCopy} disabled={copyTargets.length === 0}>
              Copy
            </Button>
          </>
        }
      >
        <fieldset>
          <legend className="sr-only">Copy to these days</legend>
          {WEEKDAYS_MON_FIRST.filter((d) => d.index !== copyFrom).map((d) => (
            <Checkbox
              key={d.index}
              label={d.label}
              checked={copyTargets.includes(d.index)}
              onChange={(e) =>
                setCopyTargets((current) =>
                  e.target.checked ? [...current, d.index] : current.filter((i) => i !== d.index),
                )
              }
            />
          ))}
        </fieldset>
      </Dialog>
    </Card>
  );
}
