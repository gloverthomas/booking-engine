"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { formatInstant, localDateOf } from "@/lib/public-api-time";
import type { ManageBookingData, SlotDto } from "@/lib/public-api-types";
import { createApiClient } from "./flow/api-client";
import { SlotPicker } from "./steps/SlotPicker";
import { BookingAside, BookingStub } from "./ui/BookingStub";
import { ArrowRight } from "./ui/icons";
import { ErrorPanel, Notice } from "./ui/Notice";
import { PublicFrame } from "./ui/PublicFrame";

type ViewState =
  | { status: "loading" }
  | { status: "notfound" }
  | { status: "error"; message: string }
  | { status: "ready"; data: ManageBookingData };

interface ManageViewProps {
  token: string;
}

export function ManageView({ token }: ManageViewProps) {
  const api = useMemo(() => createApiClient(), []);
  const [state, setState] = useState<ViewState>({ status: "loading" });
  const [message, setMessage] = useState<{ tone: "info" | "error"; text: string } | null>(null);

  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    void api.booking(token).then((result) => {
      if (cancelled) return;
      if (result.ok) setState({ status: "ready", data: result.data });
      else if (result.status === 404) setState({ status: "notfound" });
      else setState({ status: "error", message: result.error.message });
    });
    return () => {
      cancelled = true;
    };
  }, [api, token, attempt]);

  const reload = () => setAttempt((n) => n + 1);

  return (
    <PublicFrame>
      {() => (
        <div className="rk-confirm">
          <h1 className="rk-confirm__title rk-display">
            Your booking<span className="rk-masthead__dot">.</span>
          </h1>

          {state.status === "loading" ? (
            <p className="rk-confirm__lede" role="status">
              <span className="rk-spinner" aria-hidden="true" /> Finding your booking…
            </p>
          ) : null}

          {state.status === "notfound" ? (
            <>
              <p className="rk-confirm__lede">
                We couldn&apos;t find that booking. Check the link in your confirmation email or
                text.
              </p>
              <div className="rk-actions">
                <Link className="rk-btn" href="/book">
                  Book an appointment <ArrowRight />
                </Link>
              </div>
            </>
          ) : null}

          {state.status === "error" ? (
            <div className="rk-step-body">
              <ErrorPanel message={state.message} onRetry={reload} />
            </div>
          ) : null}

          {state.status === "ready" ? (
            <>
              {message ? (
                <div style={{ marginTop: "var(--rk-s-5)" }}>
                  <Notice tone={message.tone}>{message.text}</Notice>
                </div>
              ) : null}
              <BookingStub data={state.data} />
              <ManageActions
                api={api}
                token={token}
                data={state.data}
                onMessage={setMessage}
                onChanged={reload}
              />
              <BookingAside data={state.data} />
            </>
          ) : null}
        </div>
      )}
    </PublicFrame>
  );
}

interface ManageActionsProps {
  api: ReturnType<typeof createApiClient>;
  token: string;
  data: ManageBookingData;
  onMessage: (m: { tone: "info" | "error"; text: string } | null) => void;
  onChanged: () => void;
}

function ManageActions({ api, token, data, onMessage, onChanged }: ManageActionsProps) {
  const { cancellation, location } = data;
  const [rescheduling, setRescheduling] = useState(false);
  const [confirmingCancel, setConfirmingCancel] = useState(false);

  if (!cancellation.canCancel && !cancellation.canReschedule) {
    return cancellation.blockedReason ? (
      <p className="rk-confirm__lede">{cancellation.blockedReason}</p>
    ) : null;
  }

  return (
    <>
      <div className="rk-actions">
        {cancellation.canReschedule ? (
          <button
            type="button"
            className="rk-btn"
            aria-expanded={rescheduling}
            onClick={() => setRescheduling((v) => !v)}
          >
            {rescheduling ? "Keep my time" : "Move this booking"}
          </button>
        ) : null}
        {cancellation.canCancel ? (
          <button
            type="button"
            className="rk-btn rk-btn--ghost"
            onClick={() => setConfirmingCancel(true)}
          >
            Cancel booking
          </button>
        ) : null}
      </div>

      {!cancellation.canReschedule && cancellation.blockedReason ? (
        <p className="rk-step-lede">
          {cancellation.blockedReason}
          {location.phone ? (
            <>
              {" "}
              Call <a href={`tel:${location.phone.replace(/\s/g, "")}`}>{location.phone}</a>.
            </>
          ) : null}
        </p>
      ) : null}

      {rescheduling ? (
        <ReschedulePanel
          api={api}
          token={token}
          data={data}
          onDone={(text) => {
            setRescheduling(false);
            onMessage({ tone: "info", text });
            onChanged();
          }}
          onError={(text) => onMessage({ tone: "error", text })}
        />
      ) : null}

      <CancelDialog
        open={confirmingCancel}
        data={data}
        onClose={() => setConfirmingCancel(false)}
        onConfirm={async () => {
          const result = await api.cancel(token);
          setConfirmingCancel(false);
          if (result.ok) {
            onMessage({ tone: "info", text: result.data.message });
            onChanged();
          } else {
            onMessage({ tone: "error", text: result.error.message });
          }
        }}
      />
    </>
  );
}

interface ReschedulePanelProps {
  api: ReturnType<typeof createApiClient>;
  token: string;
  data: ManageBookingData;
  onDone: (message: string) => void;
  onError: (message: string) => void;
}

function ReschedulePanel({ api, token, data, onDone, onError }: ReschedulePanelProps) {
  const [date, setDate] = useState<string | null>(null);
  const [slot, setSlot] = useState<SlotDto | null>(null);
  const [saving, setSaving] = useState(false);
  const [epoch, setEpoch] = useState(0);
  const { timezone } = data;

  const submit = async () => {
    if (!slot || saving) return;
    setSaving(true);
    const result = await api.reschedule(token, slot.start);
    setSaving(false);
    if (result.ok) {
      onDone(`Done. Your booking is now ${formatInstant(result.data.start, timezone)}.`);
      return;
    }
    onError(result.error.message);
    if (result.error.code === "slot_taken") {
      setSlot(null);
      setEpoch((n) => n + 1);
    }
  };

  return (
    <section className="rk-panel" aria-labelledby="rk-reschedule-title">
      <h2 className="rk-panel__title" id="rk-reschedule-title">
        Pick a new time
      </h2>
      <SlotPicker
        key={epoch}
        api={api}
        locationId={data.location.id}
        serviceIds={data.serviceIds}
        staffId={data.staffId ?? undefined}
        today={localDateOf(data.now, timezone)}
        maxAdvanceDays={data.maxAdvanceDays}
        timezone={timezone}
        date={date}
        slot={slot}
        onDate={(d) => {
          setDate(d);
          setSlot(null);
        }}
        onSlot={setSlot}
      />
      <div className="rk-actions">
        <button
          type="button"
          className="rk-btn"
          disabled={!slot || saving}
          onClick={() => void submit()}
        >
          {saving ? "Moving…" : slot ? `Move to ${slot.label}` : "Choose a time"}
          {saving ? null : <ArrowRight />}
        </button>
      </div>
    </section>
  );
}

interface CancelDialogProps {
  open: boolean;
  data: ManageBookingData;
  onClose: () => void;
  onConfirm: () => Promise<void>;
}

/** Native <dialog>: focus trap, Escape and backdrop come for free. States the money outcome first. */
function CancelDialog({ open, data, onClose, onConfirm }: CancelDialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const [busy, setBusy] = useState(false);
  const { cancellation, booking, timezone } = data;
  const forfeits = cancellation.depositOutcome === "keep";

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog ref={ref} className="rk-dialog" aria-labelledby="rk-cancel-title" onClose={onClose}>
      <div className="rk-dialog__body">
        <h2 className="rk-panel__title" id="rk-cancel-title" style={{ marginBottom: 0 }}>
          Cancel this booking?
        </h2>
        <p>{formatInstant(booking.start, timezone)}</p>
        <div className={`rk-dialog__outcome${forfeits ? " is-forfeit" : ""}`}>
          {cancellation.depositOutcome !== "none" ? (
            <span className={`rk-badge ${forfeits ? "rk-badge--warn" : "rk-badge--ok"}`}>
              {forfeits
                ? "Deposit forfeited"
                : cancellation.depositOutcome === "credit"
                  ? "Deposit kept as credit"
                  : "Deposit refunded"}
            </span>
          ) : null}
          <p>{cancellation.cancelMessage}</p>
        </div>
        <div className="rk-dialog__buttons">
          <button type="button" className="rk-btn rk-btn--ghost" onClick={onClose} autoFocus>
            Keep my booking
          </button>
          <button
            type="button"
            className="rk-btn rk-btn--danger"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              await onConfirm();
              setBusy(false);
            }}
          >
            {busy ? "Cancelling…" : "Yes, cancel it"}
          </button>
        </div>
      </div>
    </dialog>
  );
}
