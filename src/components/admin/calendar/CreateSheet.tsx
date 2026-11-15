"use client";

import { useMemo, useState } from "react";
import { createBlockAction, createBookingAction } from "@/app/(admin)/calendar/actions";
import type { CalendarResources } from "@/server/admin/types";
import { callAction } from "./api";
import { ClientPicker, type ClientChoice } from "./ClientPicker";
import { formatMoney } from "./format";
import { Button, Chips, Field, Input, Select, Sheet, Switch, Textarea, useToast } from "./ui-shim";
import { fromWallClockInput, toWallClockInput } from "./wallclock";

export interface CreateDefaults {
  start: Date;
  end: Date;
  locationId?: string;
  staffId?: string;
}

type Mode = "booking" | "block";

export function CreateSheet({
  open,
  defaults,
  resources,
  onClose,
  onCreated,
}: {
  open: boolean;
  defaults: CreateDefaults | null;
  resources: CalendarResources;
  onClose: () => void;
  onCreated: () => void;
}) {
  return (
    <Sheet open={open} onClose={onClose} title="New">
      {open && defaults ? (
        <CreateForm
          defaults={defaults}
          resources={resources}
          onClose={onClose}
          onCreated={onCreated}
        />
      ) : null}
    </Sheet>
  );
}

function CreateForm({
  defaults,
  resources,
  onClose,
  onCreated,
}: {
  defaults: CreateDefaults;
  resources: CalendarResources;
  onClose: () => void;
  onCreated: () => void;
}) {
  const [mode, setMode] = useState<Mode>("booking");
  return (
    <div className="flex flex-col gap-5">
      <Chips<Mode>
        label="What to add"
        value={mode}
        onChange={setMode}
        options={[
          { value: "booking", label: "Booking" },
          { value: "block", label: "Block time" },
        ]}
      />
      {mode === "booking" ? (
        <BookingForm
          defaults={defaults}
          resources={resources}
          onClose={onClose}
          onCreated={onCreated}
        />
      ) : (
        <BlockForm
          defaults={defaults}
          resources={resources}
          onClose={onClose}
          onCreated={onCreated}
        />
      )}
    </div>
  );
}

/* Booking ----------------------------------------------------------------- */

function BookingForm({
  defaults,
  resources,
  onClose,
  onCreated,
}: {
  defaults: CreateDefaults;
  resources: CalendarResources;
  onClose: () => void;
  onCreated: () => void;
}) {
  const toast = useToast();
  const { timezone } = resources;
  const [client, setClient] = useState<ClientChoice | null>(null);
  const [locationId, setLocationId] = useState(
    defaults.locationId ?? resources.locations[0]?.id ?? "",
  );
  // "" means first available. A stylist's own column is fixed on the server whatever is sent.
  const [staffId, setStaffId] = useState(defaults.staffId ?? "");
  const [serviceIds, setServiceIds] = useState<string[]>([]);
  const [start, setStart] = useState(() => toWallClockInput(defaults.start, timezone));
  const [notify, setNotify] = useState(true);
  const [comments, setComments] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const offered = useMemo(
    () =>
      resources.services.filter(
        (s) => s.locationIds.length === 0 || s.locationIds.includes(locationId),
      ),
    [resources.services, locationId],
  );

  // Selections the chosen location does not offer drop out automatically.
  const chosen = offered.filter((s) => serviceIds.includes(s.id));
  const chosenIds = chosen.map((s) => s.id);
  const totalCents = chosen.reduce((sum, s) => sum + s.priceCents, 0);
  const totalMin = chosen.reduce((sum, s) => sum + s.durationMin, 0);
  const startDate = fromWallClockInput(start, timezone);

  const clientReady =
    client?.kind === "existing" ||
    (client?.kind === "new" &&
      client.draft.firstName.trim() !== "" &&
      client.draft.phone.trim() !== "");
  const canSubmit = clientReady && chosen.length > 0 && startDate !== null && locationId !== "";

  async function submit() {
    if (!client || !startDate) return;
    setBusy(true);
    setError(null);
    const result = await callAction(() =>
      createBookingAction({
        locationId,
        staffId: resources.viewer.seesAll ? staffId || undefined : undefined,
        serviceIds: chosenIds,
        start: startDate.toISOString(),
        client:
          client.kind === "existing"
            ? { existingClientId: client.client.id }
            : { newClient: client.draft },
        comments: comments.trim() || undefined,
        notifyClient: notify,
      }),
    );
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      toast({ tone: "error", title: "Booking not created", description: result.error });
      return;
    }
    toast({ tone: "success", title: "Booking created" });
    onCreated();
    onClose();
  }

  return (
    <form
      className="flex flex-col gap-5"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <ClientPicker value={client} onChange={setClient} />

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {resources.locations.length > 1 ? (
          <Field label="Location">
            {(id) => (
              <Select id={id} value={locationId} onChange={(e) => setLocationId(e.target.value)}>
                {resources.locations.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        ) : null}
        {resources.viewer.seesAll && resources.staff.length > 1 ? (
          <Field
            label="Stylist"
            hint={
              staffId
                ? "Booked as a request for this person."
                : "The first stylist who is free takes it."
            }
          >
            {(id) => (
              <Select id={id} value={staffId} onChange={(e) => setStaffId(e.target.value)}>
                <option value="">First available</option>
                {resources.staff.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        ) : null}
      </div>

      <fieldset className="flex flex-col gap-1">
        <legend className="mb-1 text-sm font-medium text-stone-700">Services</legend>
        {offered.length === 0 ? (
          <p className="text-sm text-stone-500">No services are offered at this location.</p>
        ) : null}
        {offered.map((s) => {
          const checked = serviceIds.includes(s.id);
          return (
            <label
              key={s.id}
              className="flex min-h-11 cursor-pointer items-center gap-3 rounded-lg border border-stone-200 px-3 py-2 has-[:checked]:border-stone-900 has-[:checked]:bg-stone-100"
            >
              <input
                type="checkbox"
                className="size-5 accent-stone-900"
                checked={checked}
                onChange={(e) =>
                  setServiceIds((current) =>
                    e.target.checked ? [...current, s.id] : current.filter((id) => id !== s.id),
                  )
                }
              />
              <span className="flex-1 text-sm">
                {s.name} <span className="text-stone-500">· {s.durationMin} min</span>
              </span>
              <span className="text-sm">{formatMoney(s.priceCents)}</span>
            </label>
          );
        })}
        {chosen.length > 0 ? (
          <p className="mt-1 text-sm text-stone-600">
            {chosen.length} {chosen.length === 1 ? "service" : "services"} · {totalMin} min ·{" "}
            {formatMoney(totalCents)}
          </p>
        ) : null}
      </fieldset>

      <Field label="Start" hint="No deposit is taken for bookings you make.">
        {(id) => (
          <Input
            id={id}
            type="datetime-local"
            step={60 * resources.slotStepMin}
            value={start}
            onChange={(e) => setStart(e.target.value)}
          />
        )}
      </Field>

      <Field label="Note (optional)">
        {(id) => (
          <Textarea
            id={id}
            value={comments}
            maxLength={1000}
            onChange={(e) => setComments(e.target.value)}
          />
        )}
      </Field>

      <Switch
        checked={notify}
        onChange={setNotify}
        label="Send confirmation to the client"
        description="Email and SMS confirmation."
      />

      {error ? (
        <p role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-900">
          {error}
        </p>
      ) : null}

      <Button type="submit" loading={busy} disabled={!canSubmit}>
        Create booking
      </Button>
    </form>
  );
}

/* Block ------------------------------------------------------------------- */

function BlockForm({
  defaults,
  resources,
  onClose,
  onCreated,
}: {
  defaults: CreateDefaults;
  resources: CalendarResources;
  onClose: () => void;
  onCreated: () => void;
}) {
  const toast = useToast();
  const { timezone } = resources;
  const ownId = resources.staff.find((s) => s.id === resources.viewer.staffId)?.id;
  const [staffId, setStaffId] = useState(defaults.staffId || ownId || resources.staff[0]?.id || "");
  const [start, setStart] = useState(() => toWallClockInput(defaults.start, timezone));
  const [end, setEnd] = useState(() => toWallClockInput(defaults.end, timezone));
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const startDate = fromWallClockInput(start, timezone);
  const endDate = fromWallClockInput(end, timezone);
  const valid = startDate !== null && endDate !== null && endDate > startDate && staffId !== "";

  async function submit() {
    if (!startDate || !endDate) return;
    setBusy(true);
    setError(null);
    const result = await callAction(() =>
      createBlockAction({
        staffId,
        start: startDate.toISOString(),
        end: endDate.toISOString(),
        reason: reason.trim() || undefined,
      }),
    );
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      toast({ tone: "error", title: "Time not blocked", description: result.error });
      return;
    }
    const { overlappingBookings } = result.data;
    toast({
      tone: overlappingBookings > 0 ? "info" : "success",
      title: "Time blocked",
      description:
        overlappingBookings > 0
          ? `${overlappingBookings} existing ${overlappingBookings === 1 ? "booking overlaps" : "bookings overlap"} this time.`
          : undefined,
    });
    onCreated();
    onClose();
  }

  return (
    <form
      className="flex flex-col gap-5"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      {resources.viewer.seesAll && resources.staff.length > 1 ? (
        <Field label="Stylist">
          {(id) => (
            <Select id={id} value={staffId} onChange={(e) => setStaffId(e.target.value)}>
              {resources.staff.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </Select>
          )}
        </Field>
      ) : null}
      <Field label="From">
        {(id) => (
          <Input
            id={id}
            type="datetime-local"
            value={start}
            onChange={(e) => setStart(e.target.value)}
          />
        )}
      </Field>
      <Field label="Until">
        {(id) => (
          <Input
            id={id}
            type="datetime-local"
            value={end}
            onChange={(e) => setEnd(e.target.value)}
          />
        )}
      </Field>
      <Field label="Reason (optional)">
        {(id) => (
          <Input
            id={id}
            value={reason}
            maxLength={200}
            placeholder="Lunch, leave, appointment elsewhere"
            onChange={(e) => setReason(e.target.value)}
          />
        )}
      </Field>
      {error ? (
        <p role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-900">
          {error}
        </p>
      ) : null}
      <Button type="submit" loading={busy} disabled={!valid}>
        Block time
      </Button>
    </form>
  );
}
