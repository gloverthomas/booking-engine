"use client";

import { useCallback, useEffect, useId, useState } from "react";
import { clockInAction, clockOutAction } from "@/app/(admin)/timesheets/actions";
import { Button, Input, Select } from "@/components/ui";
import type { ClockPayload } from "@/server/timesheets/clock-payload";
import { formatDuration } from "@/server/timesheets/duration";

type Loaded = Extract<ClockPayload, { available: true }>;
const TICK_MS = 30_000;

/** Null when the person has no clock (not signed in, no permission, no staff profile) or the request failed. */
async function fetchClockState(): Promise<ClockPayload | null> {
  try {
    const res = await fetch("/timesheets/clock", { cache: "no-store" });
    if (!res.ok || !res.headers.get("content-type")?.includes("json")) return null;
    return (await res.json()) as ClockPayload;
  } catch {
    return null;
  }
}

/**
 * A small "Clock in / Clock out" control for the admin shell, shown to anyone with timesheets.clock. It loads its
 * own state, so it needs no props. Clocked out: "Clock in" (with a location picker when there is more than one
 * place). Clocked in: "Clocked in since 9:02 am, 3h 10m" and "Clock out", which asks for any break first.
 */
export function ClockWidget() {
  const [state, setState] = useState<Loaded | null>(null);
  const [hidden, setHidden] = useState(false);
  const [offsetMs, setOffsetMs] = useState(0);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [locationId, setLocationId] = useState("");
  const [askBreak, setAskBreak] = useState(false);
  const [breakText, setBreakText] = useState("0");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [announce, setAnnounce] = useState("");
  const ids = { loc: useId(), brk: useId() };

  const apply = useCallback((data: ClockPayload | null) => {
    if (!data || !data.available) {
      setHidden(true);
      return;
    }
    setOffsetMs(new Date(data.serverNow).getTime() - Date.now());
    setState(data);
    setLocationId((current) =>
      data.locations.some((l) => l.id === current)
        ? current
        : data.locations.length === 1
          ? data.locations[0].id
          : "",
    );
  }, []);

  const load = useCallback(async () => apply(await fetchClockState()), [apply]);

  useEffect(() => {
    let cancelled = false;
    void fetchClockState().then((data) => {
      if (!cancelled) apply(data);
    });
    return () => {
      cancelled = true;
    };
  }, [apply]);

  const clockedIn = state?.open != null;
  useEffect(() => {
    if (!clockedIn) return;
    const timer = setInterval(() => setNowMs(Date.now()), TICK_MS);
    return () => clearInterval(timer);
  }, [clockedIn]);

  async function run(action: () => ReturnType<typeof clockInAction>, done: string) {
    setBusy(true);
    setError(null);
    try {
      const result = await action();
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setAskBreak(false);
      setBreakText("0");
      setAnnounce(done);
      await load();
      setNowMs(Date.now());
    } catch {
      setError("We couldn't reach the server. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  if (hidden || !state) return null;

  const open = state.open;
  const elapsedMin = open
    ? Math.max(0, (nowMs + offsetMs - new Date(open.since).getTime()) / 60_000)
    : 0;

  return (
    <div
      role="group"
      aria-label="Time clock"
      className="flex flex-col gap-2 rounded-card border border-line bg-surface p-3 text-sm"
    >
      {open ? (
        <>
          <p className="font-semibold" aria-live="off">
            Clocked in since {open.sinceLabel}, {formatDuration(elapsedMin)}
            {open.locationName ? (
              <span className="font-normal text-ink-muted"> at {open.locationName}</span>
            ) : null}
          </p>
          {askBreak ? (
            <form
              className="flex flex-col gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                const minutes = Number(breakText);
                void run(
                  () => clockOutAction({ breakMinutes: Number.isFinite(minutes) ? minutes : 0 }),
                  "Clocked out",
                );
              }}
            >
              <Input
                id={ids.brk}
                label="Break taken (minutes)"
                type="number"
                inputMode="numeric"
                min={0}
                max={600}
                step={1}
                value={breakText}
                onChange={(e) => setBreakText(e.target.value)}
              />
              <div className="flex gap-2">
                <Button type="submit" size="sm" loading={busy} className="flex-1">
                  Confirm clock out
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  onClick={() => setAskBreak(false)}
                >
                  Cancel
                </Button>
              </div>
            </form>
          ) : (
            <Button type="button" size="sm" variant="secondary" onClick={() => setAskBreak(true)}>
              Clock out
            </Button>
          )}
        </>
      ) : (
        <>
          {state.locations.length > 1 ? (
            <Select
              id={ids.loc}
              label="Location"
              value={locationId}
              onChange={(e) => setLocationId(e.target.value)}
            >
              <option value="">No location</option>
              {state.locations.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </Select>
          ) : null}
          <Button
            type="button"
            size="sm"
            loading={busy}
            onClick={() =>
              void run(() => clockInAction({ locationId: locationId || null }), "Clocked in")
            }
          >
            Clock in
          </Button>
        </>
      )}
      {error ? (
        <p role="alert" className="text-danger">
          {error}
        </p>
      ) : null}
      <p className="sr-only" role="status">
        {announce}
      </p>
    </div>
  );
}
