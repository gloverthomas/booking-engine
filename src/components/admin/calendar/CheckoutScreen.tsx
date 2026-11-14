"use client";

import Link from "next/link";
import { useState } from "react";
import { checkoutAction, type CheckoutSummary } from "@/app/(admin)/checkout/actions";
import { computeCheckout, type ManualPaymentMethod } from "@/server/admin/checkout-math";
import type { CheckoutView } from "@/server/admin/types";
import { callAction } from "./api";
import {
  PAYMENT_KIND_LABEL,
  PAYMENT_METHOD_LABEL,
  STATUS_LABEL,
  formatDateTime,
  formatMoney,
} from "./format";
import { Button, Card, Chips, ToastProvider, useToast } from "./ui-shim";

const METHODS: ReadonlyArray<{ value: ManualPaymentMethod; label: string }> = [
  { value: "cash", label: "Cash" },
  { value: "eftpos", label: "EFTPOS" },
  { value: "other", label: "Other" },
];

const METHOD_NAMES: Record<ManualPaymentMethod, string> = {
  cash: "cash",
  eftpos: "EFTPOS",
  other: "another method",
};

export function CheckoutScreen(props: { view: CheckoutView; timezone: string }) {
  return (
    <ToastProvider>
      <CheckoutBody {...props} />
    </ToastProvider>
  );
}

function CheckoutBody({ view, timezone }: { view: CheckoutView; timezone: string }) {
  const toast = useToast();
  const [method, setMethod] = useState<ManualPaymentMethod | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<CheckoutSummary | null>(null);

  const header = (
    <header className="flex flex-col gap-1">
      <p className="text-sm text-stone-600">
        {formatDateTime(view.start, timezone)} · {view.locationName}
      </p>
      <h1 className="text-2xl font-semibold">{view.clientName}</h1>
    </header>
  );

  if (done || view.status === "completed") {
    return (
      <Screen>
        {header}
        <Receipt view={view} done={done} timezone={timezone} />
      </Screen>
    );
  }

  if (view.status !== "confirmed") {
    return (
      <Screen>
        {header}
        <Card>
          <p role="status" className="text-sm">
            This booking is <strong>{STATUS_LABEL[view.status].toLowerCase()}</strong>, so it cannot
            be checked out.
          </p>
        </Card>
        <BackLinks />
      </Screen>
    );
  }

  const amounts = computeCheckout(
    { totalCents: view.totalCents, paidCents: view.paidCents },
    { cashDiscountPct: view.cashDiscountPct },
    method ?? "other",
  );
  const nothingOwed = amounts.balanceDueCents === 0;
  const canConfirm = nothingOwed || method !== null;

  async function confirm() {
    const chosen = method ?? "other";
    setBusy(true);
    setError(null);
    const result = await callAction(() =>
      checkoutAction({ bookingId: view.bookingId, method: chosen }),
    );
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      toast({ tone: "error", title: "Checkout did not finish", description: result.error });
      return;
    }
    setDone(result.data);
  }

  return (
    <Screen>
      {header}

      <Card className="flex flex-col gap-2">
        <h2 className="sr-only">Services</h2>
        <ul className="flex flex-col divide-y divide-stone-100">
          {view.services.map((s, i) => (
            <li key={`${s.name}-${i}`} className="flex justify-between gap-3 py-2 text-sm">
              <span>{s.name}</span>
              <span>{formatMoney(s.priceCents)}</span>
            </li>
          ))}
        </ul>
        <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1 border-t border-stone-200 pt-2 text-sm">
          <dt>Total</dt>
          <dd className="text-right">{formatMoney(amounts.totalCents)}</dd>
          <dt>Already paid</dt>
          <dd className="text-right">-{formatMoney(amounts.paidCents)}</dd>
          {method === "cash" && amounts.cashDiscountCents > 0 ? (
            <>
              <dt>Cash discount ({view.cashDiscountPct}%)</dt>
              <dd className="text-right">-{formatMoney(amounts.cashDiscountCents)}</dd>
            </>
          ) : null}
        </dl>
        <p className="flex items-baseline justify-between border-t border-stone-200 pt-3">
          <span className="text-sm font-semibold uppercase tracking-wide text-stone-500">
            To collect
          </span>
          <span className="text-4xl font-semibold tabular-nums" aria-live="polite">
            {formatMoney(nothingOwed ? 0 : amounts.payableCents)}
          </span>
        </p>
      </Card>

      {view.balanceAlreadyRecorded ? (
        <p role="status" className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900">
          A balance payment is already on this booking, so nothing more will be recorded. Complete
          the booking to finish.
        </p>
      ) : null}

      {nothingOwed || view.balanceAlreadyRecorded ? null : (
        <div className="flex flex-col gap-2">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-stone-500">
            How did they pay?
          </h2>
          <Chips<ManualPaymentMethod>
            label="Payment method"
            options={METHODS}
            value={method}
            onChange={setMethod}
          />
          {view.cashDiscountPct > 0 ? (
            <p className="text-xs text-stone-500">
              Cash gets {view.cashDiscountPct}% off the balance.
            </p>
          ) : null}
        </div>
      )}

      {error ? (
        <p role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-900">
          {error}
        </p>
      ) : null}

      <Button
        loading={busy}
        disabled={!(canConfirm || view.balanceAlreadyRecorded)}
        onClick={() => void confirm()}
        className="min-h-14 text-base"
      >
        {nothingOwed || view.balanceAlreadyRecorded
          ? "Complete booking"
          : method
            ? `Take ${formatMoney(amounts.payableCents)} by ${METHOD_NAMES[method]} and complete`
            : "Choose how they paid"}
      </Button>
      <BackLinks />
    </Screen>
  );
}

function Screen({ children }: { children: React.ReactNode }) {
  return <div className="mx-auto flex w-full max-w-lg flex-col gap-5 p-4 md:p-6">{children}</div>;
}

function BackLinks() {
  return (
    <nav className="flex gap-2" aria-label="Leave checkout">
      <Link
        href="/calendar"
        className="inline-flex min-h-11 flex-1 items-center justify-center rounded-lg border border-stone-300 bg-white px-4 text-sm font-medium hover:bg-stone-100"
      >
        Back to calendar
      </Link>
    </nav>
  );
}

function Receipt({
  view,
  done,
  timezone,
}: {
  view: CheckoutView;
  done: CheckoutSummary | null;
  timezone: string;
}) {
  const paidTotal = done
    ? done.paidCents + (done.recordedPayment ? done.payableCents : 0)
    : (view.receipt?.paidCents ?? 0);
  return (
    <>
      <Card className="flex flex-col gap-3 border-emerald-300 bg-emerald-50">
        <p role="status" className="flex items-center gap-3 text-emerald-900">
          <span
            aria-hidden
            className="inline-flex size-10 items-center justify-center rounded-full bg-emerald-700 text-xl text-white"
          >
            &#10003;
          </span>
          <span className="text-xl font-semibold">Paid and completed</span>
        </p>
        {done ? (
          <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1 text-sm text-emerald-950">
            <dt>Total</dt>
            <dd className="text-right">{formatMoney(done.totalCents)}</dd>
            {done.cashDiscountCents > 0 ? (
              <>
                <dt>Cash discount</dt>
                <dd className="text-right">-{formatMoney(done.cashDiscountCents)}</dd>
              </>
            ) : null}
            <dt>
              {done.recordedPayment
                ? `Taken by ${METHOD_NAMES[done.method]} just now`
                : "Nothing more to collect"}
            </dt>
            <dd className="text-right font-semibold">
              {formatMoney(done.recordedPayment ? done.payableCents : 0)}
            </dd>
          </dl>
        ) : null}
        <p className="text-sm text-emerald-950">
          Received in total: <strong>{formatMoney(paidTotal)}</strong>
        </p>
      </Card>

      {view.receipt && !done ? (
        <Card>
          <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-stone-500">
            Payments
          </h2>
          <ul className="flex flex-col divide-y divide-stone-100">
            {view.receipt.payments.map((p) => (
              <li key={p.id} className="flex justify-between gap-3 py-2 text-sm">
                <span>
                  {PAYMENT_KIND_LABEL[p.kind]} · {PAYMENT_METHOD_LABEL[p.method]}
                  <span className="block text-xs text-stone-500">
                    {formatDateTime(p.createdAt, timezone)}
                  </span>
                </span>
                <span>
                  {p.kind === "refund" ? "-" : ""}
                  {formatMoney(p.amountCents)}
                </span>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
      <BackLinks />
    </>
  );
}
