"use client";

import { useState, type FormEvent } from "react";
import { useSubmit } from "@/components/admin/shell/use-submit";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Switch } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import type { BusinessSettings } from "@/server/settings";
import { updateSettingsAction } from "../actions";

function num(value: string): number | undefined {
  if (value.trim() === "") return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

export function SettingsForm({ initial }: { initial: BusinessSettings }) {
  const { pending, error, fieldErrors, submit } = useSubmit();
  const [v, setV] = useState({
    depositPct: String(initial.depositPct),
    cancelWindowHours: String(initial.cancelWindowHours),
    extraFeePct: String(initial.extraFeePct),
    refundOutsideWindow: initial.refundOutsideWindow,
    minNoticeMin: String(initial.minNoticeMin),
    maxAdvanceDays: String(initial.maxAdvanceDays),
    holdMinutes: String(initial.holdMinutes),
    reminderHoursBefore: String(initial.reminderHoursBefore),
    cashDiscountPct: String(initial.cashDiscountPct),
    slotStepMin: String(initial.slotStepMin),
    chooseStaff: initial.chooseStaff,
    waitlistEnabled: initial.waitlistEnabled,
    waitlistAutoOffer: initial.waitlistAutoOffer,
    waitlistOfferWindowMin: String(initial.waitlistOfferWindowMin),
    waitlistMaxOffersPerSlot: String(initial.waitlistMaxOffersPerSlot),
    staffAlertsEnabled: initial.staffAlertsEnabled,
    policyText: initial.policyText,
  });
  const [version, setVersion] = useState(initial.policyVersion);
  const policyEdited = v.policyText.trim() !== initial.policyText.trim();

  function set<K extends keyof typeof v>(key: K, value: (typeof v)[K]) {
    setV((current) => ({ ...current, [key]: value }));
  }

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    submit(
      () =>
        updateSettingsAction({
          depositPct: num(v.depositPct),
          cancelWindowHours: num(v.cancelWindowHours),
          extraFeePct: num(v.extraFeePct),
          refundOutsideWindow: v.refundOutsideWindow,
          minNoticeMin: num(v.minNoticeMin),
          maxAdvanceDays: num(v.maxAdvanceDays),
          holdMinutes: num(v.holdMinutes),
          reminderHoursBefore: num(v.reminderHoursBefore),
          cashDiscountPct: num(v.cashDiscountPct),
          slotStepMin: num(v.slotStepMin),
          chooseStaff: v.chooseStaff,
          waitlistEnabled: v.waitlistEnabled,
          waitlistAutoOffer: v.waitlistAutoOffer,
          waitlistOfferWindowMin: num(v.waitlistOfferWindowMin),
          waitlistMaxOffersPerSlot: num(v.waitlistMaxOffersPerSlot),
          staffAlertsEnabled: v.staffAlertsEnabled,
          policyText: v.policyText,
        }),
      {
        success: "Settings saved",
        onSuccess: (data) => {
          if (data) setVersion(data.policyVersion);
        },
      },
    );
  }

  return (
    <form onSubmit={onSubmit} noValidate className="flex flex-col gap-6">
      {error ? <Alert tone="danger">{error}</Alert> : null}

      <Card aria-labelledby="set-deposit">
        <CardHeader
          eyebrow="Payments"
          title={<span id="set-deposit">Deposits and cancellations</span>}
        />
        <CardBody className="grid gap-4 sm:grid-cols-2">
          <Input
            label="Deposit at booking"
            suffix="%"
            type="number"
            inputMode="decimal"
            min={0}
            max={100}
            value={v.depositPct}
            onChange={(e) => set("depositPct", e.target.value)}
            error={fieldErrors.depositPct}
            hint="Share of the total taken when the client books. A service can override it."
          />
          <Input
            label="Cancellation window"
            suffix="hours"
            type="number"
            inputMode="numeric"
            min={0}
            value={v.cancelWindowHours}
            onChange={(e) => set("cancelWindowHours", e.target.value)}
            error={fieldErrors.cancelWindowHours}
            hint="Changes or cancellations inside this window forfeit the deposit."
          />
          <Input
            label="Extra fee on late cancel or no-show"
            suffix="%"
            type="number"
            inputMode="decimal"
            min={0}
            max={100}
            value={v.extraFeePct}
            onChange={(e) => set("extraFeePct", e.target.value)}
            error={fieldErrors.extraFeePct}
            hint="Percent of the total, charged to the saved card. 0 keeps the deposit only."
          />
          <Select
            label="Cancelled outside the window"
            value={v.refundOutsideWindow}
            onChange={(e) =>
              set("refundOutsideWindow", e.target.value as BusinessSettings["refundOutsideWindow"])
            }
            error={fieldErrors.refundOutsideWindow}
            hint="What happens to the deposit when the client cancels in time."
          >
            <option value="refund">Refund the deposit</option>
            <option value="credit">Keep it as credit</option>
          </Select>
          <Input
            label="Cash discount"
            suffix="%"
            type="number"
            inputMode="decimal"
            min={0}
            max={100}
            value={v.cashDiscountPct}
            onChange={(e) => set("cashDiscountPct", e.target.value)}
            error={fieldErrors.cashDiscountPct}
            hint="Applied at checkout when the client pays in cash."
          />
        </CardBody>
      </Card>

      <Card aria-labelledby="set-booking">
        <CardHeader eyebrow="Booking page" title={<span id="set-booking">Booking rules</span>} />
        <CardBody className="grid gap-4 sm:grid-cols-2">
          <Input
            label="Minimum notice"
            suffix="min"
            type="number"
            inputMode="numeric"
            min={0}
            value={v.minNoticeMin}
            onChange={(e) => set("minNoticeMin", e.target.value)}
            error={fieldErrors.minNoticeMin}
            hint="How soon before the start time a client can still book online."
          />
          <Input
            label="Book up to"
            suffix="days ahead"
            type="number"
            inputMode="numeric"
            min={1}
            value={v.maxAdvanceDays}
            onChange={(e) => set("maxAdvanceDays", e.target.value)}
            error={fieldErrors.maxAdvanceDays}
          />
          <Input
            label="Hold an unpaid slot for"
            suffix="min"
            type="number"
            inputMode="numeric"
            min={1}
            max={60}
            value={v.holdMinutes}
            onChange={(e) => set("holdMinutes", e.target.value)}
            error={fieldErrors.holdMinutes}
            hint="How long a client has to pay the deposit before the slot is released."
          />
          <Input
            label="Time slot step"
            suffix="min"
            type="number"
            inputMode="numeric"
            min={5}
            max={60}
            step={5}
            value={v.slotStepMin}
            onChange={(e) => set("slotStepMin", e.target.value)}
            error={fieldErrors.slotStepMin}
            hint="Start times are offered every this many minutes."
          />
          <Input
            label="Send reminder"
            suffix="hours before"
            type="number"
            inputMode="numeric"
            min={1}
            value={v.reminderHoursBefore}
            onChange={(e) => set("reminderHoursBefore", e.target.value)}
            error={fieldErrors.reminderHoursBefore}
            hint="Reminder SMS timing."
          />
          <Switch
            label="Let clients choose their stylist"
            checked={v.chooseStaff}
            onChange={(e) => set("chooseStaff", e.target.checked)}
            hint="Turn on once more than one stylist takes bookings. Clients can still choose 'anyone'."
            wrapperClassName="sm:col-span-2"
          />
        </CardBody>
      </Card>

      <Card aria-labelledby="set-waitlist">
        <CardHeader
          eyebrow="Waitlist"
          title={<span id="set-waitlist">When the day is full</span>}
        />
        <CardBody className="grid gap-4 sm:grid-cols-2">
          <Switch
            label="Let clients join a waitlist"
            checked={v.waitlistEnabled}
            onChange={(e) => set("waitlistEnabled", e.target.checked)}
            hint="Shown on the booking page when there are no times that suit."
            wrapperClassName="sm:col-span-2"
          />
          <Switch
            label="Offer freed-up times automatically"
            checked={v.waitlistAutoOffer}
            onChange={(e) => set("waitlistAutoOffer", e.target.checked)}
            hint="When a cancellation frees a slot, text the people it suits. Off means you choose who to offer it to."
            disabled={!v.waitlistEnabled}
            wrapperClassName="sm:col-span-2"
          />
          <Input
            label="Offer stays open for"
            suffix="min"
            type="number"
            inputMode="numeric"
            min={5}
            max={240}
            value={v.waitlistOfferWindowMin}
            onChange={(e) => set("waitlistOfferWindowMin", e.target.value)}
            error={fieldErrors.waitlistOfferWindowMin}
            disabled={!v.waitlistEnabled}
            hint="How long the claim link in the text works."
          />
          <Input
            label="People offered one slot at once"
            suffix="people"
            type="number"
            inputMode="numeric"
            min={1}
            max={20}
            value={v.waitlistMaxOffersPerSlot}
            onChange={(e) => set("waitlistMaxOffersPerSlot", e.target.value)}
            error={fieldErrors.waitlistMaxOffersPerSlot}
            disabled={!v.waitlistEnabled}
            hint="The first to pay the deposit gets it; the others are told it's gone."
          />
        </CardBody>
      </Card>

      <Card aria-labelledby="set-team">
        <CardHeader eyebrow="Team" title={<span id="set-team">Stylist alerts</span>} />
        <CardBody>
          <Switch
            label="Alert stylists about their bookings"
            checked={v.staffAlertsEnabled}
            onChange={(e) => set("staffAlertsEnabled", e.target.checked)}
            hint="Email, and a text when their phone is set under Staff, whenever a booking is made, moved or cancelled."
          />
        </CardBody>
      </Card>

      <Card aria-labelledby="set-policy">
        <CardHeader
          eyebrow="Policy"
          title={<span id="set-policy">Cancellation policy</span>}
          actions={<Badge tone="peach">Version {version}</Badge>}
        />
        <CardBody className="flex flex-col gap-3">
          <Textarea
            label="Policy text"
            rows={9}
            value={v.policyText}
            onChange={(e) => set("policyText", e.target.value)}
            error={fieldErrors.policyText}
            hint="Clients tick this at booking. We keep the version they accepted as evidence for late-cancel fees."
          />
          {policyEdited ? (
            <Alert tone="info">
              Saving will publish this as version {Number.parseInt(version, 10) + 1 || 2}. Bookings
              already made keep the version their client accepted.
            </Alert>
          ) : null}
        </CardBody>
      </Card>

      <div className="sticky bottom-[calc(var(--bottom-nav-h)+env(safe-area-inset-bottom))] -mx-[var(--space-page)] border-t border-ink bg-paper px-[var(--space-page)] py-3 lg:static lg:mx-0 lg:border-0 lg:bg-transparent lg:px-0">
        <Button type="submit" loading={pending}>
          Save settings
        </Button>
      </div>
    </form>
  );
}
