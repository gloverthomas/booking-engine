"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { useSubmit } from "@/components/admin/shell/use-submit";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Switch } from "@/components/ui/checkbox";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { deleteLocationAction, saveLocationAction } from "../actions";

export interface LocationFormInitial {
  id?: string;
  name: string;
  addressLine: string;
  suburb: string;
  state: string;
  postcode: string;
  phone: string;
  arrivalNote: string;
  active: boolean;
  sortOrder: number;
}

export function LocationForm({ initial }: { initial: LocationFormInitial }) {
  const router = useRouter();
  const { pending, error, fieldErrors, submit } = useSubmit();
  const isNew = !initial.id;
  const [values, setValues] = useState(initial);
  const [confirmDelete, setConfirmDelete] = useState(false);

  function set<K extends keyof LocationFormInitial>(key: K, value: LocationFormInitial[K]) {
    setValues((current) => ({ ...current, [key]: value }));
  }

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    submit(
      () =>
        saveLocationAction({
          id: initial.id,
          name: values.name,
          addressLine: values.addressLine,
          suburb: values.suburb,
          state: values.state,
          postcode: values.postcode,
          phone: values.phone,
          arrivalNote: values.arrivalNote,
          active: values.active,
          sortOrder: Number.isFinite(values.sortOrder) ? values.sortOrder : 0,
        }),
      {
        success: isNew ? "Location created" : "Location saved",
        onSuccess: () => router.push("/catalog/locations"),
      },
    );
  }

  function onDelete() {
    if (!initial.id) return;
    const id = initial.id;
    setConfirmDelete(false);
    submit(() => deleteLocationAction(id), {
      success: "Location deleted",
      onSuccess: () => router.push("/catalog/locations"),
    });
  }

  return (
    <form onSubmit={onSubmit} noValidate className="flex flex-col gap-6">
      {error ? <Alert tone="danger">{error}</Alert> : null}

      <Card aria-labelledby="loc-address">
        <CardHeader title={<span id="loc-address">Address</span>} />
        <CardBody className="grid gap-4 sm:grid-cols-6">
          <Input
            label="Name"
            required
            value={values.name}
            onChange={(e) => set("name", e.target.value)}
            error={fieldErrors.name}
            wrapperClassName="sm:col-span-6"
            hint="Shown to clients, e.g. “Northside (Lola Fortune)”."
          />
          <Input
            label="Street address"
            value={values.addressLine}
            onChange={(e) => set("addressLine", e.target.value)}
            error={fieldErrors.addressLine}
            autoComplete="off"
            wrapperClassName="sm:col-span-6"
          />
          <Input
            label="Suburb"
            value={values.suburb}
            onChange={(e) => set("suburb", e.target.value)}
            error={fieldErrors.suburb}
            wrapperClassName="sm:col-span-3"
          />
          <Input
            label="State"
            value={values.state}
            onChange={(e) => set("state", e.target.value)}
            error={fieldErrors.state}
            wrapperClassName="sm:col-span-1"
          />
          <Input
            label="Postcode"
            inputMode="numeric"
            value={values.postcode}
            onChange={(e) => set("postcode", e.target.value)}
            error={fieldErrors.postcode}
            wrapperClassName="sm:col-span-2"
          />
          <Input
            label="Phone"
            type="tel"
            value={values.phone}
            onChange={(e) => set("phone", e.target.value)}
            error={fieldErrors.phone}
            wrapperClassName="sm:col-span-3"
          />
          <Input
            label="Sort order"
            type="number"
            inputMode="numeric"
            min={0}
            value={String(values.sortOrder)}
            onChange={(e) => set("sortOrder", Number(e.target.value))}
            error={fieldErrors.sortOrder}
            hint="Lower numbers show first."
            wrapperClassName="sm:col-span-3"
          />
        </CardBody>
      </Card>

      <Card aria-labelledby="loc-clients">
        <CardHeader title={<span id="loc-clients">For clients</span>} />
        <CardBody className="flex flex-col gap-4">
          <Textarea
            label="Arrival note"
            value={values.arrivalNote}
            onChange={(e) => set("arrivalNote", e.target.value)}
            error={fieldErrors.arrivalNote}
            hint="Included in confirmations, e.g. parking or which door to use."
            rows={3}
          />
          <Switch
            label="Active"
            checked={values.active}
            onChange={(e) => set("active", e.target.checked)}
            hint="Inactive locations stop taking new bookings."
          />
        </CardBody>
      </Card>

      <div className="sticky bottom-[calc(var(--bottom-nav-h)+env(safe-area-inset-bottom))] -mx-[var(--space-page)] flex flex-wrap items-center gap-3 border-t border-ink bg-paper px-[var(--space-page)] py-3 lg:static lg:mx-0 lg:border-0 lg:bg-transparent lg:px-0">
        <Button type="submit" loading={pending}>
          {isNew ? "Create location" : "Save changes"}
        </Button>
        <Button type="button" variant="ghost" onClick={() => router.push("/catalog/locations")}>
          Cancel
        </Button>
        {!isNew ? (
          <Button
            type="button"
            variant="ghost"
            className="ml-auto text-danger"
            onClick={() => setConfirmDelete(true)}
          >
            Delete
          </Button>
        ) : null}
      </div>

      <Dialog
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        title="Delete location?"
        description="A location with bookings can't be deleted; deactivate it instead."
        footer={
          <>
            <Button variant="secondary" onClick={() => setConfirmDelete(false)}>
              Keep it
            </Button>
            <Button variant="danger" onClick={onDelete}>
              Delete location
            </Button>
          </>
        }
      >
        <p className="text-sm text-ink-muted">{values.name || "This location"}</p>
      </Dialog>
    </form>
  );
}
