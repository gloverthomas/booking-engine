"use client";

import { useEffect, useRef, useState } from "react";
import {
  URGENT_BELOW_MS,
  formatCountdown,
  remainingFraction,
  remainingMs,
  type HoldClock,
} from "../flow/countdown";

interface HoldCountdownProps {
  clock: HoldClock;
  onExpire: () => void;
}

/** "We're holding your time for 9:42". Ticks from elapsed client time, so clock skew cannot cheat it. */
export function HoldCountdown({ clock, onExpire }: HoldCountdownProps) {
  const [now, setNow] = useState(clock.receivedAtMs);
  const expiredRef = useRef(false);

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);

  const remaining = remainingMs(clock, now);
  const urgent = remaining > 0 && remaining < URGENT_BELOW_MS;
  const expired = remaining <= 0 && now > clock.receivedAtMs;

  useEffect(() => {
    if (expired && !expiredRef.current) {
      expiredRef.current = true;
      onExpire();
    }
  }, [expired, onExpire]);

  return (
    <div className={`rk-hold${urgent ? " is-urgent" : ""}`}>
      <div className="rk-hold__row">
        <span className="rk-eyebrow">We&apos;re holding your time</span>
        <span className="rk-hold__time" role="timer" aria-label="Time left to pay">
          {formatCountdown(remaining)}
        </span>
      </div>
      <div className="rk-hold__track" aria-hidden="true">
        <div
          className="rk-hold__bar"
          style={{ transform: `scaleX(${remainingFraction(clock, now)})` }}
        />
      </div>
      <p className="rk-sr-only" role="status">
        {urgent ? "Less than a minute left to pay." : ""}
      </p>
    </div>
  );
}
