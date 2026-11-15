"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { formatDayHeading } from "@/lib/public-api-time";
import type { WaitlistEntryData } from "@/server/waitlist/wire";
import { ArrowRight } from "../ui/icons";
import { ErrorPanel, Notice } from "../ui/Notice";
import { PublicFrame } from "../ui/PublicFrame";
import { createWaitlistClient } from "./waitlist-api";
import "./waitlist.css";

type View =
  | { status: "loading" }
  | { status: "notfound" }
  | { status: "error"; message: string }
  | { status: "ready"; entry: WaitlistEntryData }
  | { status: "left" };

export function LeaveWaitlistView({ token }: { token: string }) {
  const client = useMemo(() => createWaitlistClient(), []);
  const [view, setView] = useState<View>({ status: "loading" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void client.entry(token).then((result) => {
      if (cancelled) return;
      if (result.ok) {
        setView(
          result.data.status === "cancelled"
            ? { status: "left" }
            : { status: "ready", entry: result.data },
        );
      } else if (result.status === 404) setView({ status: "notfound" });
      else setView({ status: "error", message: result.error.message });
    });
    return () => {
      cancelled = true;
    };
  }, [client, token]);

  const leave = async () => {
    setBusy(true);
    setError(null);
    const result = await client.leave(token);
    setBusy(false);
    if (result.ok) setView({ status: "left" });
    else setError(result.error.message);
  };

  return (
    <PublicFrame>
      {() => (
        <div className="rk-wl">
          <h1 className="rk-wl__title rk-display">
            {view.status === "left" ? "You've left" : "Leave the waitlist"}
            <span className="rk-masthead__dot">.</span>
          </h1>
          {view.status === "loading" ? (
            <p className="rk-wl__lede" role="status">
              <span className="rk-spinner" aria-hidden="true" /> Finding your request…
            </p>
          ) : null}
          {view.status === "notfound" ? (
            <p className="rk-wl__lede">We couldn&apos;t find that request. Check the link.</p>
          ) : null}
          {view.status === "error" ? <ErrorPanel message={view.message} /> : null}
          {view.status === "left" ? (
            <>
              <p className="rk-wl__lede" role="status">
                You&apos;re off the waitlist and we won&apos;t message you about openings.
              </p>
              <div className="rk-actions">
                <Link className="rk-btn" href="/book">
                  Book an appointment <ArrowRight />
                </Link>
              </div>
            </>
          ) : null}
          {view.status === "ready" ? (
            <>
              <div className="rk-wl__selection">
                <strong>{view.entry.serviceNames.join(" + ")}</strong>
                <span>
                  {view.entry.locationName}
                  {view.entry.staffName ? ` · ${view.entry.staffName}` : ""}
                </span>
                <span>
                  {formatDayHeading(view.entry.earliestDate)} to{" "}
                  {formatDayHeading(view.entry.latestDate)} · {view.entry.daysLabel} ·{" "}
                  {view.entry.timeLabel}
                </span>
              </div>
              {view.entry.status !== "waiting" && view.entry.status !== "offered" ? (
                <Notice>This request has already ended.</Notice>
              ) : null}
              {error ? <Notice tone="error">{error}</Notice> : null}
              <div className="rk-actions">
                <button
                  type="button"
                  className="rk-btn"
                  disabled={busy}
                  onClick={() => void leave()}
                >
                  {busy ? "Leaving…" : "Leave the waitlist"}
                </button>
              </div>
            </>
          ) : null}
        </div>
      )}
    </PublicFrame>
  );
}
