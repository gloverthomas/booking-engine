"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { googleCalendarUrl } from "@/lib/public-api-ics";
import type { ManageBookingData } from "@/lib/public-api-types";
import { createApiClient } from "./flow/api-client";
import { ArrowRight } from "./ui/icons";
import { BookingAside, BookingStub } from "./ui/BookingStub";
import { ErrorPanel } from "./ui/Notice";
import { PublicFrame } from "./ui/PublicFrame";

const POLL_MS = 2000;
const MAX_POLLS = 20;

type ViewState =
  | { status: "loading" }
  | { status: "notfound" }
  | { status: "error"; message: string }
  | { status: "ready"; data: ManageBookingData; gaveUp: boolean };

interface ConfirmedViewProps {
  token: string;
}

/**
 * Landing page after paying. The card payment confirms the booking through a webhook, so for a
 * moment the booking may still read "pending": poll briefly until it flips to confirmed.
 */
export function ConfirmedView({ token }: ConfirmedViewProps) {
  const api = useMemo(() => createApiClient(), []);
  const [state, setState] = useState<ViewState>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;
    let polls = 0;

    const run = async () => {
      const result = await api.booking(token);
      if (cancelled) return;
      if (!result.ok) {
        setState(
          result.status === 404
            ? { status: "notfound" }
            : { status: "error", message: result.error.message },
        );
        return;
      }
      const pending = result.data.booking.status === "pending_payment";
      polls += 1;
      const gaveUp = pending && polls >= MAX_POLLS;
      setState({ status: "ready", data: result.data, gaveUp });
      if (pending && !gaveUp) timer = window.setTimeout(run, POLL_MS);
    };

    void run();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [api, token]);

  return (
    <PublicFrame>
      {() => (
        <div className="rk-confirm">
          {state.status === "loading" ? <Waiting text="Finding your booking…" /> : null}
          {state.status === "notfound" ? <NotFound /> : null}
          {state.status === "error" ? (
            <div className="rk-step-body">
              <ErrorPanel message={state.message} onRetry={() => window.location.reload()} />
            </div>
          ) : null}
          {state.status === "ready" ? (
            <Ready data={state.data} token={token} api={api} gaveUp={state.gaveUp} />
          ) : null}
        </div>
      )}
    </PublicFrame>
  );
}

function Waiting({ text }: { text: string }) {
  return (
    <>
      <h1 className="rk-confirm__title rk-display">
        One moment<span className="rk-masthead__dot">.</span>
      </h1>
      <p className="rk-confirm__lede" role="status">
        <span className="rk-spinner" aria-hidden="true" /> {text}
      </p>
    </>
  );
}

function NotFound() {
  return (
    <>
      <h1 className="rk-confirm__title rk-display">
        Not found<span className="rk-masthead__dot">.</span>
      </h1>
      <p className="rk-confirm__lede">
        We couldn&apos;t find that booking. Check the link in your confirmation email or text.
      </p>
      <div className="rk-actions">
        <Link className="rk-btn" href="/book">
          Book an appointment <ArrowRight />
        </Link>
      </div>
    </>
  );
}

function Ready({
  data,
  token,
  api,
  gaveUp,
}: {
  data: ManageBookingData;
  token: string;
  api: ReturnType<typeof createApiClient>;
  gaveUp: boolean;
}) {
  const { status } = data.booking;

  if (status === "pending_payment") {
    return gaveUp ? (
      <>
        <h1 className="rk-confirm__title rk-display">
          Almost there<span className="rk-masthead__dot">.</span>
        </h1>
        <p className="rk-confirm__lede">
          We haven&apos;t had confirmation of your payment yet. This page will not update by itself
          now. Refresh in a minute. If your card was charged you&apos;ll get a confirmation by email
          and text shortly.
        </p>
        <div className="rk-actions">
          <button type="button" className="rk-btn" onClick={() => window.location.reload()}>
            Refresh
          </button>
        </div>
      </>
    ) : (
      <Waiting text="Confirming your payment…" />
    );
  }

  if (status !== "confirmed") {
    return (
      <>
        <h1 className="rk-confirm__title rk-display">
          Not active<span className="rk-masthead__dot">.</span>
        </h1>
        <p className="rk-confirm__lede">
          This booking isn&apos;t active any more. You&apos;re welcome to book a new time.
        </p>
        <div className="rk-actions">
          <Link className="rk-btn" href="/book">
            Book an appointment <ArrowRight />
          </Link>
        </div>
      </>
    );
  }

  const { booking, location, businessName } = data;
  const calendarUrl = googleCalendarUrl({
    title: `${booking.services.map((s) => s.name).join(", ")} with ${businessName}`,
    description: location.arrivalNote ?? undefined,
    location: [location.name, location.address].filter(Boolean).join(", "),
    start: new Date(booking.start),
    end: new Date(booking.end),
  });

  return (
    <>
      <h1 className="rk-confirm__title rk-display">
        You&apos;re booked<span className="rk-masthead__dot">.</span>
      </h1>
      <p className="rk-confirm__lede">
        We&apos;ve sent your confirmation by email and text. See you soon.
      </p>

      <BookingStub data={data} />

      <div className="rk-actions">
        <a className="rk-btn" href={api.icsUrl(token)} download="appointment.ics">
          Add to calendar
        </a>
        <a
          className="rk-btn rk-btn--ghost"
          href={calendarUrl}
          target="_blank"
          rel="noopener noreferrer"
        >
          Google Calendar<span className="rk-sr-only"> (opens in a new tab)</span>
        </a>
        <Link className="rk-btn rk-btn--ghost" href={`/manage/${encodeURIComponent(token)}`}>
          Manage booking
        </Link>
      </div>

      <BookingAside data={data} />
    </>
  );
}
