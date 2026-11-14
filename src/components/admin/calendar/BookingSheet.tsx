"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import {
  cancelBookingAction,
  markNoShowAction,
  refundPaymentAction,
  resendConfirmationAction,
} from "@/app/(admin)/bookings/actions";
import { rescheduleBookingAction } from "@/app/(admin)/calendar/actions";
import type { BookingDetail, BookingDetailPayment } from "@/server/admin/types";
import { callAction, getJson } from "./api";
import {
  PAYMENT_KIND_LABEL,
  PAYMENT_METHOD_LABEL,
  STATUS_LABEL,
  STATUS_TONE,
  describeActor,
  describeAuditAction,
  formatDateTime,
  formatMoney,
  formatTimeRange,
} from "./format";
import {
  Badge,
  Button,
  Chips,
  Dialog,
  Field,
  Input,
  Sheet,
  Skeleton,
  Switch,
  cn,
  useToast,
} from "./ui-shim";
import { fromWallClockInput, toWallClockInput } from "./wallclock";

export interface BookingSheetProps {
  bookingId: string | null;
  timezone: string;
  onClose: () => void;
  /** Called after any change so the parent can refresh its own data. */
  onChanged: () => void;
}

type Modal = "move" | "cancel" | "noShow" | { refund: BookingDetailPayment } | null;

const REFUNDABLE_METHODS = new Set(["stripe_online", "stripe_in_person"]);
const REFUNDABLE_KINDS = new Set(["deposit", "balance", "no_show_fee", "late_cancel_fee"]);

export function BookingSheet({ bookingId, timezone, onClose, onChanged }: BookingSheetProps) {
  const toast = useToast();
  const [fetched, setFetched] = useState<{
    key: string;
    detail: BookingDetail | null;
    error: string | null;
  } | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [modal, setModal] = useState<Modal>(null);
  const [busy, setBusy] = useState(false);

  const requestKey = `${bookingId}#${reloadKey}`;

  useEffect(() => {
    if (!bookingId) return;
    const controller = new AbortController();
    getJson<{ booking: BookingDetail }>(`/bookings/${bookingId}/detail`, controller.signal)
      .then((body) => setFetched({ key: requestKey, detail: body.booking, error: null }))
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setFetched({
          key: requestKey,
          detail: null,
          error: error instanceof Error ? error.message : "Could not load this booking.",
        });
      });
    return () => controller.abort();
  }, [bookingId, requestKey]);

  const close = useCallback(() => {
    setModal(null);
    setFetched(null);
    onClose();
  }, [onClose]);

  const afterChange = useCallback(() => {
    setModal(null);
    setReloadKey((k) => k + 1);
    onChanged();
  }, [onChanged]);

  async function run<T>(
    action: () => Promise<{ ok: true; data: T } | { ok: false; error: string }>,
    onSuccess: (data: T) => void,
  ) {
    setBusy(true);
    const result = await callAction(action);
    setBusy(false);
    if (!result.ok) {
      toast({ tone: "error", title: "That did not work", description: result.error });
      return;
    }
    onSuccess(result.data);
    afterChange();
  }

  const open = bookingId !== null;
  // Keep showing the last loaded booking while a refresh is in flight.
  const current = fetched?.detail && fetched.detail.id === bookingId ? fetched.detail : null;
  const loadError = fetched && fetched.key === requestKey ? fetched.error : null;

  return (
    <>
      <Sheet open={open} onClose={close} title="Booking">
        {loadError ? (
          <div className="flex flex-col gap-3">
            <p role="alert" className="text-sm text-red-800">
              {loadError}
            </p>
            <Button variant="secondary" onClick={() => setReloadKey((k) => k + 1)}>
              Try again
            </Button>
          </div>
        ) : !current ? (
          <div className="flex flex-col gap-3" aria-busy>
            <Skeleton className="h-8 w-2/3" />
            <Skeleton className="h-20 w-full" />
            <Skeleton className="h-32 w-full" />
          </div>
        ) : (
          <BookingBody
            detail={current}
            timezone={timezone}
            busy={busy}
            onMove={() => setModal("move")}
            onCancel={() => setModal("cancel")}
            onNoShow={() => setModal("noShow")}
            onRefund={(payment) => setModal({ refund: payment })}
            onResend={() =>
              run(
                () => resendConfirmationAction({ bookingId: current.id }),
                () => toast({ tone: "success", title: "Confirmation sent again" }),
              )
            }
          />
        )}
      </Sheet>

      {current ? (
        <>
          <MoveDialog
            open={modal === "move"}
            detail={current}
            timezone={timezone}
            busy={busy}
            onClose={() => setModal(null)}
            onConfirm={(newStart, notifyClient) =>
              run(
                () =>
                  rescheduleBookingAction({
                    bookingId: current.id,
                    newStart: newStart.toISOString(),
                    notifyClient,
                  }),
                () => toast({ tone: "success", title: "Booking moved" }),
              )
            }
          />
          <CancelDialog
            open={modal === "cancel"}
            clientName={current.client.name}
            hasDeposit={current.paidCents > 0}
            busy={busy}
            onClose={() => setModal(null)}
            onConfirm={(depositMode, reason) =>
              run(
                () => cancelBookingAction({ bookingId: current.id, depositMode, reason }),
                (outcome) =>
                  toast({
                    tone: "success",
                    title: "Booking cancelled",
                    description:
                      outcome.depositAction === "refund"
                        ? "The deposit is being refunded."
                        : outcome.depositAction === "keep"
                          ? "The deposit was kept."
                          : undefined,
                  }),
              )
            }
          />
          <Dialog open={modal === "noShow"} onClose={() => setModal(null)} title="Mark as no-show?">
            <p className="text-sm text-stone-700">
              {current.client.name} did not turn up. Your cancellation policy decides what happens
              to the deposit.
            </p>
            <div className="flex gap-2">
              <Button variant="secondary" className="flex-1" onClick={() => setModal(null)}>
                Back
              </Button>
              <Button
                variant="danger"
                className="flex-1"
                loading={busy}
                onClick={() =>
                  run(
                    () => markNoShowAction({ bookingId: current.id }),
                    (outcome) =>
                      toast({
                        tone: "success",
                        title: "Marked as no-show",
                        description:
                          outcome.feeCents > 0
                            ? `A ${formatMoney(outcome.feeCents)} fee will be charged to the saved card.`
                            : undefined,
                      }),
                  )
                }
              >
                Mark no-show
              </Button>
            </div>
          </Dialog>
          {typeof modal === "object" && modal !== null ? (
            <RefundDialog
              payment={modal.refund}
              busy={busy}
              onClose={() => setModal(null)}
              onConfirm={(amountCents) =>
                run(
                  () =>
                    refundPaymentAction({
                      bookingId: current.id,
                      paymentId: modal.refund.id,
                      amountCents,
                    }),
                  () => toast({ tone: "success", title: "Refund started" }),
                )
              }
            />
          ) : null}
        </>
      ) : null}
    </>
  );
}

/* Body -------------------------------------------------------------------- */

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-2 border-t border-stone-200 pt-4">
      <h3 className="text-sm font-semibold uppercase tracking-wide text-stone-500">{title}</h3>
      {children}
    </section>
  );
}

function BookingBody({
  detail,
  timezone,
  busy,
  onMove,
  onCancel,
  onNoShow,
  onRefund,
  onResend,
}: {
  detail: BookingDetail;
  timezone: string;
  busy: boolean;
  onMove: () => void;
  onCancel: () => void;
  onNoShow: () => void;
  onRefund: (payment: BookingDetailPayment) => void;
  onResend: () => void;
}) {
  const { allowed } = detail;
  const intake = Object.entries(detail.intakeAnswers);

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={STATUS_TONE[detail.status]}>{STATUS_LABEL[detail.status]}</Badge>
          {detail.client.isVip ? <Badge tone="info">VIP</Badge> : null}
          {detail.client.blocked ? <Badge tone="bad">Blocked client</Badge> : null}
        </div>
        <p className="text-xl font-semibold">{formatDateTime(detail.start, timezone)}</p>
        <p className="text-sm text-stone-600">
          {formatTimeRange(detail.start, detail.end, timezone)} · {detail.location.name} ·{" "}
          {detail.staff.name}
        </p>
        {detail.cancelReason ? (
          <p className="text-sm text-stone-600">Reason: {detail.cancelReason}</p>
        ) : null}
      </div>

      <div className="flex flex-col gap-0.5 rounded-xl bg-stone-100 p-3">
        <Link
          href={`/clients/${detail.client.id}`}
          className="min-h-11 content-center text-base font-semibold underline-offset-2 hover:underline"
        >
          {detail.client.name}
        </Link>
        {detail.client.phone ? (
          <a
            href={`tel:${detail.client.phone}`}
            className="inline-flex min-h-11 items-center text-sm"
          >
            {detail.client.phone}
          </a>
        ) : null}
        {detail.client.email ? (
          <a
            href={`mailto:${detail.client.email}`}
            className="inline-flex min-h-11 items-center text-sm"
          >
            {detail.client.email}
          </a>
        ) : null}
        {detail.client.notes ? (
          <p className="mt-1 whitespace-pre-wrap text-sm text-stone-700">{detail.client.notes}</p>
        ) : null}
      </div>

      <div className="grid grid-cols-2 gap-2">
        {allowed.checkout ? (
          <Link
            href={`/checkout/${detail.id}`}
            className="col-span-2 inline-flex min-h-11 items-center justify-center rounded-lg bg-stone-900 px-4 text-sm font-medium text-white hover:bg-stone-700"
          >
            Check out · {formatMoney(detail.balanceDueCents)} due
          </Link>
        ) : null}
        <Button variant="secondary" disabled={!allowed.move || busy} onClick={onMove}>
          Move
        </Button>
        <Button variant="secondary" disabled={!allowed.cancel || busy} onClick={onCancel}>
          Cancel
        </Button>
        <Button variant="secondary" disabled={!allowed.noShow || busy} onClick={onNoShow}>
          No-show
        </Button>
        <Button variant="secondary" disabled={!allowed.resend || busy} onClick={onResend}>
          Resend confirmation
        </Button>
      </div>

      <Section title="Services">
        {detail.services.length === 0 ? (
          <p className="text-sm text-stone-500">No services recorded.</p>
        ) : (
          <ul className="flex flex-col divide-y divide-stone-100">
            {detail.services.map((s) => (
              <li key={s.id} className="flex items-center justify-between gap-3 py-2 text-sm">
                <span>
                  {s.name} <span className="text-stone-500">· {s.durationMin} min</span>
                </span>
                <span>{formatMoney(s.priceCents)}</span>
              </li>
            ))}
          </ul>
        )}
        <dl className="mt-1 grid grid-cols-[1fr_auto] gap-x-4 gap-y-1 text-sm">
          <dt>Total</dt>
          <dd className="text-right font-medium">{formatMoney(detail.totalCents)}</dd>
          <dt>Paid</dt>
          <dd className="text-right">{formatMoney(detail.paidCents)}</dd>
          <dt className="font-semibold">Balance due</dt>
          <dd className="text-right font-semibold">{formatMoney(detail.balanceDueCents)}</dd>
        </dl>
      </Section>

      {detail.comments || intake.length > 0 || detail.bookedForOther ? (
        <Section title="Notes from the client">
          {detail.bookedForOther ? <p className="text-sm">Booked for someone else.</p> : null}
          {detail.comments ? (
            <p className="whitespace-pre-wrap text-sm">{detail.comments}</p>
          ) : null}
          {intake.map(([question, answer]) => (
            <p key={question} className="text-sm">
              <span className="text-stone-500">{question}: </span>
              {answer}
            </p>
          ))}
        </Section>
      ) : null}

      <Section title="Payments">
        {detail.payments.length === 0 ? (
          <p className="text-sm text-stone-500">No payments yet.</p>
        ) : (
          <ul className="flex flex-col divide-y divide-stone-100">
            {detail.payments.map((p) => {
              const canRefund =
                REFUNDABLE_KINDS.has(p.kind) &&
                REFUNDABLE_METHODS.has(p.method) &&
                (p.status === "succeeded" || p.status === "partially_refunded");
              return (
                <li key={p.id} className="flex items-center justify-between gap-3 py-2 text-sm">
                  <span className="flex flex-col">
                    <span className="font-medium">
                      {PAYMENT_KIND_LABEL[p.kind]} · {PAYMENT_METHOD_LABEL[p.method]}
                    </span>
                    <span className="text-xs text-stone-500">
                      {formatDateTime(p.createdAt, timezone)}
                      {p.status !== "succeeded" ? ` · ${p.status.replace("_", " ")}` : ""}
                      {p.note ? ` · ${p.note}` : ""}
                    </span>
                  </span>
                  <span className="flex items-center gap-2">
                    <span className={cn("font-medium", p.kind === "refund" && "text-red-800")}>
                      {p.kind === "refund" ? "-" : ""}
                      {formatMoney(p.amountCents)}
                    </span>
                    {canRefund ? (
                      <Button
                        variant="ghost"
                        className="px-3"
                        disabled={busy}
                        onClick={() => onRefund(p)}
                      >
                        Refund
                      </Button>
                    ) : null}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </Section>

      <Section title="Messages">
        {detail.messages.length === 0 ? (
          <p className="text-sm text-stone-500">No messages sent.</p>
        ) : (
          <ul className="flex flex-col divide-y divide-stone-100">
            {detail.messages.map((m) => (
              <li key={m.id} className="flex flex-col py-2 text-sm">
                <span className="flex items-center justify-between gap-2">
                  <span>
                    {m.channel === "sms" ? "SMS" : "Email"} · {m.template.replaceAll("_", " ")}
                  </span>
                  <Badge
                    tone={m.status === "failed" ? "bad" : m.status === "queued" ? "warn" : "good"}
                  >
                    {m.status}
                  </Badge>
                </span>
                <span className="text-xs text-stone-500">
                  {m.toAddress} · {formatDateTime(m.sentAt ?? m.createdAt, timezone)}
                </span>
                {m.error ? <span className="text-xs text-red-800">{m.error}</span> : null}
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="History">
        {detail.audit.length === 0 ? (
          <p className="text-sm text-stone-500">Nothing recorded yet.</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {detail.audit.map((a) => (
              <li key={a.id} className="text-sm">
                {describeAuditAction(a.action)}{" "}
                <span className="text-xs text-stone-500">
                  · {describeActor(a.actor)} · {formatDateTime(a.at, timezone)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </div>
  );
}

/* Dialogs ----------------------------------------------------------------- */

function MoveDialog({
  open,
  detail,
  timezone,
  busy,
  onClose,
  onConfirm,
}: {
  open: boolean;
  detail: BookingDetail;
  timezone: string;
  busy: boolean;
  onClose: () => void;
  onConfirm: (newStart: Date, notifyClient: boolean) => void;
}) {
  return (
    <Dialog open={open} onClose={onClose} title="Move booking">
      {/* Mounted only while open, so the fields start from the booking's current time each time. */}
      <MoveForm
        detail={detail}
        timezone={timezone}
        busy={busy}
        onClose={onClose}
        onConfirm={onConfirm}
      />
    </Dialog>
  );
}

function MoveForm({
  detail,
  timezone,
  busy,
  onClose,
  onConfirm,
}: {
  detail: BookingDetail;
  timezone: string;
  busy: boolean;
  onClose: () => void;
  onConfirm: (newStart: Date, notifyClient: boolean) => void;
}) {
  const [value, setValue] = useState(() => toWallClockInput(new Date(detail.start), timezone));
  const [notify, setNotify] = useState(true);
  const parsed = fromWallClockInput(value, timezone);
  return (
    <>
      <Field label="New start time" hint={`Times are ${timezone.replace("_", " ")} time.`}>
        {(id) => (
          <Input
            id={id}
            type="datetime-local"
            step={60 * 5}
            value={value}
            onChange={(e) => setValue(e.target.value)}
          />
        )}
      </Field>
      <Switch
        checked={notify}
        onChange={setNotify}
        label="Notify the client"
        description="Sends them the new time by email and SMS."
      />
      <div className="flex gap-2">
        <Button variant="secondary" className="flex-1" onClick={onClose}>
          Back
        </Button>
        <Button
          className="flex-1"
          loading={busy}
          disabled={!parsed}
          onClick={() => parsed && onConfirm(parsed, notify)}
        >
          Move booking
        </Button>
      </div>
    </>
  );
}

function CancelDialog({
  open,
  clientName,
  hasDeposit,
  busy,
  onClose,
  onConfirm,
}: {
  open: boolean;
  clientName: string;
  hasDeposit: boolean;
  busy: boolean;
  onClose: () => void;
  onConfirm: (depositMode: "refund" | "keep", reason?: string) => void;
}) {
  return (
    <Dialog open={open} onClose={onClose} title="Cancel booking">
      <CancelForm
        clientName={clientName}
        hasDeposit={hasDeposit}
        busy={busy}
        onClose={onClose}
        onConfirm={onConfirm}
      />
    </Dialog>
  );
}

function CancelForm({
  clientName,
  hasDeposit,
  busy,
  onClose,
  onConfirm,
}: {
  clientName: string;
  hasDeposit: boolean;
  busy: boolean;
  onClose: () => void;
  onConfirm: (depositMode: "refund" | "keep", reason?: string) => void;
}) {
  const [mode, setMode] = useState<"refund" | "keep">("refund");
  const [reason, setReason] = useState("");

  return (
    <>
      <p className="text-sm text-stone-700">Cancel {clientName}&apos;s booking?</p>
      {hasDeposit ? (
        <>
          <Chips
            label="Deposit"
            value={mode}
            onChange={setMode}
            options={[
              { value: "refund", label: "Refund deposit" },
              { value: "keep", label: "Keep deposit" },
            ]}
          />
          <p className="text-xs text-stone-500">
            {mode === "refund"
              ? "Cancelling as staff normally refunds the deposit in full."
              : "Your cancellation policy decides whether the deposit is kept."}
          </p>
        </>
      ) : null}
      <Field label="Reason (optional)">
        {(id) => (
          <Input
            id={id}
            value={reason}
            maxLength={500}
            onChange={(e) => setReason(e.target.value)}
          />
        )}
      </Field>
      <div className="flex gap-2">
        <Button variant="secondary" className="flex-1" onClick={onClose}>
          Back
        </Button>
        <Button
          variant="danger"
          className="flex-1"
          loading={busy}
          onClick={() => onConfirm(hasDeposit ? mode : "refund", reason.trim() || undefined)}
        >
          Cancel booking
        </Button>
      </div>
    </>
  );
}

function RefundDialog({
  payment,
  busy,
  onClose,
  onConfirm,
}: {
  payment: BookingDetailPayment;
  busy: boolean;
  onClose: () => void;
  onConfirm: (amountCents?: number) => void;
}) {
  const [dollars, setDollars] = useState("");
  const partial = dollars.trim() === "" ? undefined : Math.round(Number(dollars) * 100);
  const invalid =
    partial !== undefined &&
    (!Number.isFinite(partial) || partial <= 0 || partial > payment.amountCents);

  return (
    <Dialog open onClose={onClose} title="Refund payment">
      <p className="text-sm text-stone-700">
        {PAYMENT_KIND_LABEL[payment.kind]} of {formatMoney(payment.amountCents)}. Leave the amount
        empty to refund it all.
      </p>
      <Field label="Amount to refund (optional)">
        {(id) => (
          <Input
            id={id}
            inputMode="decimal"
            placeholder={(payment.amountCents / 100).toFixed(2)}
            value={dollars}
            onChange={(e) => setDollars(e.target.value)}
            aria-invalid={invalid}
          />
        )}
      </Field>
      <div className="flex gap-2">
        <Button variant="secondary" className="flex-1" onClick={onClose}>
          Back
        </Button>
        <Button
          variant="danger"
          className="flex-1"
          loading={busy}
          disabled={invalid}
          onClick={() => onConfirm(partial)}
        >
          Refund
        </Button>
      </div>
    </Dialog>
  );
}
