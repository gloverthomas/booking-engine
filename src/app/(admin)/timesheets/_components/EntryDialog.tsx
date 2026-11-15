"use client";

import { useState } from "react";
import { useSubmit } from "@/components/admin/shell/use-submit";
import { Button, Dialog, Input, Select } from "@/components/ui";
import { addManualEntryAction, editEntryAction } from "../actions";

export interface EntryDialogProps {
  mode: "add" | "edit";
  staffId: string;
  /** Present when editing. Times are business-local `datetime-local` values. */
  entry?: {
    id: string;
    clockIn: string;
    clockOut: string | null;
    breakMinutes: number;
    locationId: string | null;
    note: string | null;
  };
  /** A sensible starting day for a new entry (YYYY-MM-DD). */
  defaultDate: string;
  locations: Array<{ id: string; name: string }>;
}

/** Add a missed shift, or correct one. Every change needs a reason: it goes in the audit log. */
export function EntryDialog({ mode, staffId, entry, defaultDate, locations }: EntryDialogProps) {
  const [open, setOpen] = useState(false);
  const { pending, error, fieldErrors, submit, clearErrors } = useSubmit();
  const editing = mode === "edit" && entry;

  function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const text = (key: string) => String(data.get(key) ?? "");
    const common = {
      breakMinutes: text("breakMinutes") || "0",
      locationId: text("locationId") || null,
      note: text("note") || null,
      reason: text("reason"),
    };
    if (editing) {
      submit(
        () =>
          editEntryAction({
            entryId: entry.id,
            clockIn: text("clockIn"),
            ...(text("clockOut") ? { clockOut: text("clockOut") } : {}),
            ...common,
          }),
        { success: "Entry updated", onSuccess: () => setOpen(false) },
      );
    } else {
      submit(
        () =>
          addManualEntryAction({
            staffId,
            clockIn: text("clockIn"),
            clockOut: text("clockOut"),
            ...common,
          }),
        { success: "Entry added", onSuccess: () => setOpen(false) },
      );
    }
  }

  return (
    <>
      <Button
        type="button"
        size="sm"
        variant={editing ? "ghost" : "secondary"}
        onClick={() => {
          clearErrors();
          setOpen(true);
        }}
      >
        {editing ? "Edit" : "Add entry"}
      </Button>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title={editing ? "Edit time entry" : "Add a time entry"}
        description="Times are in the business time zone. The reason is kept in the audit log."
      >
        <form onSubmit={onSubmit} className="flex flex-col gap-3" noValidate>
          <Input
            name="clockIn"
            label="Start"
            type="datetime-local"
            required
            defaultValue={entry?.clockIn ?? `${defaultDate}T09:00`}
            error={fieldErrors.clockIn}
          />
          <Input
            name="clockOut"
            label="End"
            type="datetime-local"
            required={!editing || entry?.clockOut !== null}
            defaultValue={entry?.clockOut ?? (editing ? "" : `${defaultDate}T17:00`)}
            hint={
              editing && entry?.clockOut === null
                ? "Leave empty to keep them clocked in."
                : undefined
            }
            error={fieldErrors.clockOut}
          />
          <Input
            name="breakMinutes"
            label="Unpaid break (minutes)"
            type="number"
            inputMode="numeric"
            min={0}
            max={600}
            defaultValue={entry?.breakMinutes ?? 0}
            error={fieldErrors.breakMinutes}
          />
          <Select
            name="locationId"
            label="Location"
            defaultValue={entry?.locationId ?? ""}
            error={fieldErrors.locationId}
          >
            <option value="">No location</option>
            {locations.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </Select>
          <Input
            name="note"
            label="Note (optional)"
            defaultValue={entry?.note ?? ""}
            maxLength={500}
            error={fieldErrors.note}
          />
          <Input
            name="reason"
            label="Reason for this change"
            required
            minLength={3}
            maxLength={300}
            placeholder="e.g. Forgot to clock in"
            error={fieldErrors.reason}
          />
          {error ? (
            <p role="alert" className="text-sm text-danger">
              {error}
            </p>
          ) : null}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="secondary" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" loading={pending}>
              Save
            </Button>
          </div>
        </form>
      </Dialog>
    </>
  );
}
