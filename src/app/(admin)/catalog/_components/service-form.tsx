"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { useSubmit } from "@/components/admin/shell/use-submit";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Checkbox, Switch } from "@/components/ui/checkbox";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import type { ServiceFormInput } from "@/server/admin-foundation/catalog-schemas";
import { centsToInputValue } from "@/server/admin-foundation/money";
import { deleteServiceAction, saveServiceAction } from "../actions";
import { IntakeQuestionsEditor, type IntakeQuestionDraft } from "./intake-questions-editor";

export interface ServiceFormInitial {
  id?: string;
  name: string;
  description: string;
  category: string;
  durationMin: number;
  priceCents: number;
  bufferMin: number;
  depositPct: number | null;
  vipOnly: boolean;
  active: boolean;
  sortOrder: number;
  intakeQuestions: IntakeQuestionDraft[];
  locationIds: string[];
  staff: Array<{ staffId: string; priceCents: number | null; durationMin: number | null }>;
}

export interface ServiceFormProps {
  initial: ServiceFormInitial;
  locations: Array<{ id: string; name: string; active: boolean }>;
  staff: Array<{ id: string; name: string }>;
  /** Business default deposit %, shown as the placeholder for the override. */
  defaultDepositPct: number;
  categories: string[];
}

interface OfferingDraft {
  offered: boolean;
  price: string;
  durationMin: string;
}

function toNumber(value: string): number | undefined {
  if (value.trim() === "") return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

export function ServiceForm({
  initial,
  locations,
  staff,
  defaultDepositPct,
  categories,
}: ServiceFormProps) {
  const router = useRouter();
  const { pending, error, fieldErrors, submit } = useSubmit();
  const isNew = !initial.id;

  const [name, setName] = useState(initial.name);
  const [description, setDescription] = useState(initial.description);
  const [category, setCategory] = useState(initial.category);
  const [durationMin, setDurationMin] = useState(String(initial.durationMin));
  const [price, setPrice] = useState(isNew ? "" : centsToInputValue(initial.priceCents));
  const [bufferMin, setBufferMin] = useState(String(initial.bufferMin));
  const [depositPct, setDepositPct] = useState(
    initial.depositPct === null ? "" : String(initial.depositPct),
  );
  const [sortOrder, setSortOrder] = useState(String(initial.sortOrder));
  const [vipOnly, setVipOnly] = useState(initial.vipOnly);
  const [active, setActive] = useState(initial.active);
  const [questions, setQuestions] = useState<IntakeQuestionDraft[]>(initial.intakeQuestions);
  const [locationIds, setLocationIds] = useState<string[]>(initial.locationIds);
  const [offerings, setOfferings] = useState<Record<string, OfferingDraft>>(() =>
    Object.fromEntries(
      staff.map((s) => {
        const existing = initial.staff.find((o) => o.staffId === s.id);
        return [
          s.id,
          {
            offered: Boolean(existing) || (isNew && staff.length === 1),
            price: centsToInputValue(existing?.priceCents),
            durationMin: existing?.durationMin ? String(existing.durationMin) : "",
          },
        ];
      }),
    ),
  );
  const [confirmDelete, setConfirmDelete] = useState(false);

  function buildInput(): ServiceFormInput {
    return {
      id: initial.id,
      name,
      description,
      category,
      durationMin: toNumber(durationMin) ?? Number.NaN,
      price,
      bufferMin: toNumber(bufferMin) ?? 0,
      depositPct: toNumber(depositPct) ?? null,
      vipOnly,
      active,
      sortOrder: toNumber(sortOrder) ?? 0,
      intakeQuestions: questions,
      locationIds,
      staff: staff
        .filter((s) => offerings[s.id]?.offered)
        .map((s) => ({
          staffId: s.id,
          price: offerings[s.id]?.price ?? "",
          durationMin: toNumber(offerings[s.id]?.durationMin ?? "") ?? null,
        })),
    };
  }

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    submit(() => saveServiceAction(buildInput()), {
      success: isNew ? "Service created" : "Service saved",
      onSuccess: () => router.push("/catalog"),
    });
  }

  function onDelete() {
    if (!initial.id) return;
    const id = initial.id;
    submit(() => deleteServiceAction(id), {
      success: "Service deleted",
      onSuccess: () => router.push("/catalog"),
    });
    setConfirmDelete(false);
  }

  function toggleLocation(id: string, checked: boolean) {
    setLocationIds((current) =>
      checked ? [...current, id] : current.filter((existing) => existing !== id),
    );
  }

  function updateOffering(staffId: string, patch: Partial<OfferingDraft>) {
    setOfferings((current) => ({
      ...current,
      [staffId]: {
        ...(current[staffId] ?? { offered: false, price: "", durationMin: "" }),
        ...patch,
      },
    }));
  }

  return (
    <form onSubmit={onSubmit} noValidate className="flex flex-col gap-6">
      {error ? <Alert tone="danger">{error}</Alert> : null}

      <Card aria-labelledby="svc-basics">
        <CardHeader title={<span id="svc-basics">The service</span>} />
        <CardBody className="grid gap-4 sm:grid-cols-2">
          <Input
            label="Name"
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            error={fieldErrors.name}
            wrapperClassName="sm:col-span-2"
            autoComplete="off"
          />
          <Input
            label="Category"
            list="service-categories"
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            error={fieldErrors.category}
            hint="Optional. Groups services on the booking page."
          />
          <datalist id="service-categories">
            {categories.map((c) => (
              <option key={c} value={c} />
            ))}
          </datalist>
          <Input
            label="Sort order"
            type="number"
            inputMode="numeric"
            min={0}
            value={sortOrder}
            onChange={(e) => setSortOrder(e.target.value)}
            error={fieldErrors.sortOrder}
            hint="Lower numbers show first."
          />
          <Textarea
            label="Description"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            error={fieldErrors.description}
            hint="Shown to clients when they pick the service."
            wrapperClassName="sm:col-span-2"
            rows={3}
          />
        </CardBody>
      </Card>

      <Card aria-labelledby="svc-pricing">
        <CardHeader title={<span id="svc-pricing">Price and time</span>} />
        <CardBody className="grid gap-4 sm:grid-cols-2">
          <Input
            label="Price"
            required
            prefix="$"
            inputMode="decimal"
            value={price}
            onChange={(e) => setPrice(e.target.value)}
            error={fieldErrors.price}
            placeholder="95.00"
          />
          <Input
            label="Duration"
            required
            suffix="min"
            type="number"
            inputMode="numeric"
            min={5}
            step={5}
            value={durationMin}
            onChange={(e) => setDurationMin(e.target.value)}
            error={fieldErrors.durationMin}
          />
          <Input
            label="Buffer after"
            suffix="min"
            type="number"
            inputMode="numeric"
            min={0}
            step={5}
            value={bufferMin}
            onChange={(e) => setBufferMin(e.target.value)}
            error={fieldErrors.bufferMin}
            hint="Padding after the appointment. Clients don't see it."
          />
          <Input
            label="Deposit override"
            suffix="%"
            type="number"
            inputMode="numeric"
            min={0}
            max={100}
            value={depositPct}
            onChange={(e) => setDepositPct(e.target.value)}
            error={fieldErrors.depositPct}
            placeholder={String(defaultDepositPct)}
            hint={`Leave blank to use the business default (${defaultDepositPct}%).`}
          />
        </CardBody>
      </Card>

      <Card aria-labelledby="svc-where">
        <CardHeader title={<span id="svc-where">Where and who</span>} />
        <CardBody className="flex flex-col gap-6">
          <fieldset>
            <legend className="eyebrow mb-1">Offered at</legend>
            {locations.length === 0 ? (
              <p className="text-sm text-ink-muted">Add a location first.</p>
            ) : (
              locations.map((l) => (
                <Checkbox
                  key={l.id}
                  label={l.active ? l.name : `${l.name} (inactive)`}
                  checked={locationIds.includes(l.id)}
                  onChange={(e) => toggleLocation(l.id, e.target.checked)}
                />
              ))
            )}
            {fieldErrors.locationIds ? (
              <p className="text-sm font-medium text-danger">{fieldErrors.locationIds}</p>
            ) : null}
          </fieldset>

          <fieldset>
            <legend className="eyebrow mb-1">Offered by</legend>
            {staff.map((s, index) => {
              const draft = offerings[s.id] ?? { offered: false, price: "", durationMin: "" };
              return (
                <div key={s.id} className="border-b border-line py-1 last:border-b-0">
                  <Checkbox
                    label={s.name}
                    checked={draft.offered}
                    onChange={(e) => updateOffering(s.id, { offered: e.target.checked })}
                  />
                  {draft.offered ? (
                    <div className="grid gap-3 pb-3 pl-8 sm:grid-cols-2">
                      <Input
                        label={`Price for ${s.name}`}
                        prefix="$"
                        inputMode="decimal"
                        value={draft.price}
                        onChange={(e) => updateOffering(s.id, { price: e.target.value })}
                        error={fieldErrors[`staff.${index}.price`]}
                        hint="Blank uses the service price."
                      />
                      <Input
                        label={`Duration for ${s.name}`}
                        suffix="min"
                        type="number"
                        inputMode="numeric"
                        min={5}
                        step={5}
                        value={draft.durationMin}
                        onChange={(e) => updateOffering(s.id, { durationMin: e.target.value })}
                        error={fieldErrors[`staff.${index}.durationMin`]}
                        hint="Blank uses the service duration."
                      />
                    </div>
                  ) : null}
                </div>
              );
            })}
          </fieldset>
        </CardBody>
      </Card>

      <Card aria-labelledby="svc-intake">
        <CardHeader title={<span id="svc-intake">Questions for the client</span>} />
        <CardBody>
          <IntakeQuestionsEditor
            questions={questions}
            onChange={setQuestions}
            errors={fieldErrors}
          />
        </CardBody>
      </Card>

      <Card aria-labelledby="svc-visibility">
        <CardHeader title={<span id="svc-visibility">Visibility</span>} />
        <CardBody className="flex flex-col">
          <Switch
            label="Active"
            checked={active}
            onChange={(e) => setActive(e.target.checked)}
            hint="Inactive services are hidden from the booking page but keep their history."
          />
          <Switch
            label="VIP clients only"
            checked={vipOnly}
            onChange={(e) => setVipOnly(e.target.checked)}
            hint="Only clients marked VIP can book this service online."
          />
        </CardBody>
      </Card>

      <div className="sticky bottom-[calc(var(--bottom-nav-h)+env(safe-area-inset-bottom))] -mx-[var(--space-page)] flex flex-wrap items-center gap-3 border-t border-ink bg-paper px-[var(--space-page)] py-3 lg:static lg:mx-0 lg:border-0 lg:bg-transparent lg:px-0">
        <Button type="submit" loading={pending}>
          {isNew ? "Create service" : "Save changes"}
        </Button>
        <Button type="button" variant="ghost" onClick={() => router.push("/catalog")}>
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
        title="Delete service?"
        description="This removes the service from the catalog. If it is on any booking you'll be asked to deactivate it instead."
        footer={
          <>
            <Button variant="secondary" onClick={() => setConfirmDelete(false)}>
              Keep it
            </Button>
            <Button variant="danger" onClick={onDelete}>
              Delete service
            </Button>
          </>
        }
      >
        <p className="text-sm text-ink-muted">{name || "This service"}</p>
      </Dialog>
    </form>
  );
}
