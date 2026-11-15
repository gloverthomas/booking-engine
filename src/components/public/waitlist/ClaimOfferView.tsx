"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { formatAud } from "@/lib/public-api-money";
import { formatInstant } from "@/lib/public-api-time";
import type { WaitlistClaimData, WaitlistOfferData } from "@/server/waitlist/wire";
import {
  formatCountdown,
  makeHoldClock,
  remainingMs,
  startHoldClock,
  type HoldClock,
} from "../flow/countdown";
import { EMPTY_DETAILS } from "../flow/details";
import { policyBody } from "../flow/policy-copy";
import { PayStep } from "../steps/PayStep";
import { CheckField } from "../ui/Field";
import { HoldCountdown } from "../ui/HoldCountdown";
import { ArrowRight } from "../ui/icons";
import { ErrorPanel, Notice } from "../ui/Notice";
import { PublicFrame } from "../ui/PublicFrame";
import { createWaitlistClient, type WaitlistClient } from "./waitlist-api";
import "./waitlist.css";

type View =
  | { status: "loading" }
  | { status: "notfound" }
  | { status: "error"; message: string }
  | { status: "ready"; offer: WaitlistOfferData; clock: HoldClock }
  | { status: "paying"; offer: WaitlistOfferData; claim: WaitlistClaimData; clock: HoldClock }
  | { status: "gone"; reason: "expired" | "slot_taken" | "cancelled" | "claimed" };

interface ClaimOfferViewProps {
  token: string;
}

export function ClaimOfferView({ token }: ClaimOfferViewProps) {
  const client = useMemo(() => createWaitlistClient(), []);
  const [view, setView] = useState<View>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    void client.offer(token).then((result) => {
      if (cancelled) return;
      if (!result.ok) {
        setView(
          result.status === 404
            ? { status: "notfound" }
            : { status: "error", message: result.error.message },
        );
        return;
      }
      const offer = result.data;
      if (offer.status === "sent" || (offer.status === "claimed" && offer.resumable)) {
        setView({
          status: "ready",
          offer,
          clock: makeHoldClock(offer.expiresAt, offer.serverNow, Date.now()),
        });
      } else {
        setView({ status: "gone", reason: offer.status === "sent" ? "expired" : offer.status });
      }
    });
    return () => {
      cancelled = true;
    };
  }, [client, token, attempt]);

  return (
    <PublicFrame>
      {() => (
        <div className="rk-wl">
          <Body
            view={view}
            client={client}
            token={token}
            onRetry={() => setAttempt((n) => n + 1)}
            onView={setView}
          />
        </div>
      )}
    </PublicFrame>
  );
}

interface BodyProps {
  view: View;
  client: WaitlistClient;
  token: string;
  onRetry: () => void;
  onView: (view: View) => void;
}

function Title({ children }: { children: string }) {
  return (
    <h1 className="rk-wl__title rk-display">
      {children}
      <span className="rk-masthead__dot">.</span>
    </h1>
  );
}

function Body({ view, client, token, onRetry, onView }: BodyProps) {
  switch (view.status) {
    case "loading":
      return (
        <>
          <Title>One moment</Title>
          <p className="rk-wl__lede" role="status">
            <span className="rk-spinner" aria-hidden="true" /> Finding your offer…
          </p>
        </>
      );
    case "notfound":
      return (
        <>
          <Title>Not found</Title>
          <p className="rk-wl__lede">
            We couldn&apos;t find that offer. Check the link in your email or text.
          </p>
          <BookLink />
        </>
      );
    case "error":
      return <ErrorPanel message={view.message} onRetry={onRetry} />;
    case "gone":
      return <Gone reason={view.reason} />;
    case "paying":
      return <Paying view={view} onExpire={() => onView({ status: "gone", reason: "expired" })} />;
    case "ready":
      return <Ready view={view} client={client} token={token} onView={onView} />;
  }
}

function BookLink() {
  return (
    <div className="rk-actions">
      <Link className="rk-btn" href="/book">
        Book an appointment <ArrowRight />
      </Link>
    </div>
  );
}

const GONE_COPY: Record<"expired" | "slot_taken" | "cancelled" | "claimed", [string, string]> = {
  expired: [
    "Offer ended",
    "This offer has run out of time. You're still on the waitlist, and we'll message you if another time opens up.",
  ],
  slot_taken: [
    "Just missed it",
    "Someone else claimed this time first. You're still on the waitlist for the next opening.",
  ],
  cancelled: ["No longer available", "This offer is no longer available."],
  claimed: ["Already claimed", "This time has already been claimed."],
};

function Gone({ reason }: { reason: "expired" | "slot_taken" | "cancelled" | "claimed" }) {
  const [title, text] = GONE_COPY[reason];
  return (
    <>
      <Title>{title}</Title>
      <p className="rk-wl__lede" role="status">
        {text}
      </p>
      <BookLink />
    </>
  );
}

function Countdown({ clock, onExpire }: { clock: HoldClock; onExpire: () => void }) {
  const [now, setNow] = useState(clock.receivedAtMs);
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);
  const left = remainingMs(clock, now);
  useEffect(() => {
    if (left <= 0 && now > clock.receivedAtMs) onExpire();
  }, [left, now, clock.receivedAtMs, onExpire]);
  return (
    <p className="rk-wl__left">
      <span className="rk-eyebrow">Held for you for </span>
      <span role="timer" aria-label="Time left to claim">
        {formatCountdown(left)}
      </span>
    </p>
  );
}

interface ReadyProps {
  view: Extract<View, { status: "ready" }>;
  client: WaitlistClient;
  token: string;
  onView: (view: View) => void;
}

function Ready({ view, client, token, onView }: ReadyProps) {
  const { offer } = view;
  const [accepted, setAccepted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const claim = async () => {
    if (!accepted) {
      setError("You need to agree to the cancellation policy.");
      return;
    }
    setBusy(true);
    setError(null);
    const result = await client.claim(token, offer.policy.version);
    setBusy(false);
    if (result.ok) {
      const data = result.data;
      if (data.confirmed) {
        window.location.assign(`/book/confirmed/${data.manageToken}`);
        return;
      }
      onView({
        status: "paying",
        offer,
        claim: data,
        clock: startHoldClock(data.holdExpiresAt, data.serverNow),
      });
      return;
    }
    const { code, fieldErrors } = result.error;
    if (code === "slot_taken") onView({ status: "gone", reason: "slot_taken" });
    else if (code === "offer_gone") {
      const reason = fieldErrors?.reason;
      onView({
        status: "gone",
        reason: reason === "cancelled" || reason === "claimed" ? reason : "expired",
      });
    } else setError(result.error.message);
  };

  return (
    <>
      <Title>A time opened up</Title>
      <p className="rk-wl__lede">
        Hi, a time has come free with {offer.staffName}. The first person to pay the deposit gets
        it.
      </p>
      <div className="rk-wl__offer">
        <p className="rk-eyebrow">{offer.locationName}</p>
        <p className="rk-wl__offer-when">{formatInstant(offer.start, offer.timezone)}</p>
        <ul>
          {offer.services.map((s) => (
            <li key={s.name}>
              <span>{s.name}</span>
              <span className="rk-mono">{formatAud(s.priceCents)}</span>
            </li>
          ))}
        </ul>
        <p className="rk-mono">
          Deposit {formatAud(offer.depositCents)} of {formatAud(offer.totalCents)}
        </p>
        <Countdown
          clock={view.clock}
          onExpire={() => onView({ status: "gone", reason: "expired" })}
        />
      </div>

      <div className="rk-policy">
        <p className="rk-policy__text">
          {policyBody({ ...offer.policy, refundOutsideWindow: "refund" })}
        </p>
      </div>
      <CheckField id="policy" checked={accepted} onChange={setAccepted} required>
        I&apos;ve read and agree to the cancellation policy.
      </CheckField>
      {error ? <Notice tone="error">{error}</Notice> : null}
      <div className="rk-actions">
        <button type="button" className="rk-btn" disabled={busy} onClick={() => void claim()}>
          {busy
            ? "Claiming…"
            : offer.depositCents > 0
              ? "Claim and pay deposit"
              : "Claim this time"}
          {busy ? null : <ArrowRight />}
        </button>
      </div>
      <p className="rk-wl__promise">
        We may have offered this time to others too. If it goes first to someone else, you stay on
        the waitlist.
      </p>
    </>
  );
}

function Paying({
  view,
  onExpire,
}: {
  view: Extract<View, { status: "paying" }>;
  onExpire: () => void;
}) {
  const router = useRouter();
  const { claim, offer } = view;
  const [expired, setExpired] = useState(false);
  const target = `/book/confirmed/${claim.manageToken}`;
  const details = {
    ...EMPTY_DETAILS,
    firstName: claim.billing.name,
    email: claim.billing.email,
    phone: claim.billing.phone,
  };

  return (
    <>
      <Title>Pay to secure it</Title>
      <p className="rk-wl__lede">
        {formatInstant(claim.start, offer.timezone)}, {offer.locationName}
      </p>
      <HoldCountdown
        clock={view.clock}
        onExpire={() => {
          setExpired(true);
          onExpire();
        }}
      />
      <PayStep
        hold={{ ...claim, payment: claim.payment }}
        details={details}
        returnUrl={`${window.location.origin}${target}`}
        onPaid={() => router.push(target)}
        expired={expired}
      />
    </>
  );
}
