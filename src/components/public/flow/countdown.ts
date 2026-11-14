export interface HoldClock {
  /** Hold expiry, ms since epoch (server clock). */
  expiresAtMs: number;
  /** Server clock when the hold response was produced. */
  serverNowMs: number;
  /** Client clock when that response arrived. */
  receivedAtMs: number;
}

export function makeHoldClock(
  holdExpiresAt: string,
  serverNow: string,
  receivedAtMs: number,
): HoldClock {
  return {
    expiresAtMs: Date.parse(holdExpiresAt),
    serverNowMs: Date.parse(serverNow),
    receivedAtMs,
  };
}

/**
 * Milliseconds left on the hold, corrected for the difference between the visitor's clock and
 * ours: we only trust elapsed time on the client, never its absolute time.
 */
export function remainingMs(clock: HoldClock, clientNowMs: number): number {
  const elapsed = Math.max(0, clientNowMs - clock.receivedAtMs);
  return Math.max(0, clock.expiresAtMs - (clock.serverNowMs + elapsed));
}

/** "9:42" */
export function formatCountdown(ms: number): string {
  const totalSeconds = Math.ceil(Math.max(0, ms) / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

/** Fraction of the hold left, 0 to 1, for the progress bar. */
export function remainingFraction(clock: HoldClock, clientNowMs: number): number {
  const total = clock.expiresAtMs - clock.serverNowMs;
  if (total <= 0) return 0;
  return Math.min(1, remainingMs(clock, clientNowMs) / total);
}

export const URGENT_BELOW_MS = 60_000;

/** Clock for a hold that has just been received. */
export function startHoldClock(holdExpiresAt: string, serverNow: string): HoldClock {
  return makeHoldClock(holdExpiresAt, serverNow, Date.now());
}
