"use client";

import dynamic from "next/dynamic";
import { useCallback, useRef, useState, useSyncExternalStore } from "react";
import { deleteBlockAction, rescheduleBookingAction } from "@/app/(admin)/calendar/actions";
import type { CalendarResources } from "@/server/admin/types";
import { callAction } from "./api";
import { BookingSheet } from "./BookingSheet";
import type { CalendarHandle, CalendarViewName, RescheduleRequest } from "./CalendarView";
import { CreateSheet, type CreateDefaults } from "./CreateSheet";
import { formatDateTime } from "./format";
import {
  Button,
  Chips,
  Dialog,
  Select,
  Skeleton,
  Switch,
  ToastProvider,
  useToast,
} from "./ui-shim";

const CalendarView = dynamic(() => import("./CalendarView"), {
  ssr: false,
  loading: () => <Skeleton className="h-full w-full" />,
});

const VIEW_OPTIONS: ReadonlyArray<{ value: CalendarViewName; label: string }> = [
  { value: "timeGridDay", label: "Day" },
  { value: "timeGridThreeDay", label: "3 day" },
  { value: "timeGridWeek", label: "Week" },
];

interface BlockInfo {
  id: string;
  kind: "block" | "external";
  reason: string | null;
}

export function CalendarApp({ resources }: { resources: CalendarResources }) {
  return (
    <ToastProvider>
      <CalendarScreen resources={resources} />
    </ToastProvider>
  );
}

const NARROW_QUERY = "(max-width: 767px)";

function subscribeNarrow(onChange: () => void): () => void {
  const media = window.matchMedia(NARROW_QUERY);
  media.addEventListener("change", onChange);
  return () => media.removeEventListener("change", onChange);
}

function isNarrow(): boolean {
  return window.matchMedia(NARROW_QUERY).matches;
}

function roundUpToStep(date: Date, stepMin: number): Date {
  const step = stepMin * 60_000;
  return new Date(Math.ceil(date.getTime() / step) * step);
}

function CalendarScreen({ resources }: { resources: CalendarResources }) {
  const toast = useToast();
  const handle = useRef<CalendarHandle>(null);
  const [view, setView] = useState<CalendarViewName | null>(null);
  const [title, setTitle] = useState("");
  const [loading, setLoading] = useState(false);
  const [locationId, setLocationId] = useState("");
  const [staffId, setStaffId] = useState("");
  const [bookingId, setBookingId] = useState<string | null>(null);
  const [block, setBlock] = useState<BlockInfo | null>(null);
  const [createDefaults, setCreateDefaults] = useState<CreateDefaults | null>(null);
  const [pendingMove, setPendingMove] = useState<RescheduleRequest | null>(null);
  const [notifyMove, setNotifyMove] = useState(true);
  const [busy, setBusy] = useState(false);

  // Phones get the 3-day view; wider screens the full week.
  const narrow = useSyncExternalStore(subscribeNarrow, isNarrow, () => false);
  const defaultView: CalendarViewName = narrow ? "timeGridThreeDay" : "timeGridWeek";
  const activeView = view ?? defaultView;

  const refetch = useCallback(() => handle.current?.refetch(), []);

  const handleTitle = useCallback((next: string, current: CalendarViewName) => {
    setTitle(next);
    setView(current);
  }, []);

  const handleLoadError = useCallback(
    (message: string) =>
      toast({ tone: "error", title: "Calendar did not load", description: message }),
    [toast],
  );

  const openCreate = useCallback(
    (start: Date, end: Date) =>
      setCreateDefaults({
        start,
        end,
        locationId: locationId || undefined,
        staffId: staffId || undefined,
      }),
    [locationId, staffId],
  );

  const openCreateNow = useCallback(() => {
    const start = roundUpToStep(new Date(), resources.slotStepMin);
    openCreate(start, new Date(start.getTime() + 45 * 60_000));
  }, [openCreate, resources.slotStepMin]);

  const requestMove = useCallback((request: RescheduleRequest) => {
    setNotifyMove(true);
    setPendingMove(request);
  }, []);

  const cancelMove = useCallback(() => {
    if (busy) return;
    pendingMove?.revert();
    setPendingMove(null);
  }, [busy, pendingMove]);

  async function confirmMove() {
    if (!pendingMove) return;
    setBusy(true);
    const result = await callAction(() =>
      rescheduleBookingAction({
        bookingId: pendingMove.bookingId,
        newStart: pendingMove.newStart.toISOString(),
        notifyClient: notifyMove,
      }),
    );
    setBusy(false);
    if (!result.ok) {
      pendingMove.revert();
      setPendingMove(null);
      toast({ tone: "error", title: "Booking not moved", description: result.error });
      return;
    }
    setPendingMove(null);
    toast({ tone: "success", title: "Booking moved" });
    refetch();
  }

  async function removeBlock() {
    if (!block) return;
    const target = block;
    setBusy(true);
    handle.current?.removeEvent(`block:${target.id}`);
    const result = await callAction(() => deleteBlockAction({ blockId: target.id }));
    setBusy(false);
    setBlock(null);
    if (!result.ok) {
      toast({ tone: "error", title: "Could not remove blocked time", description: result.error });
      refetch();
      return;
    }
    toast({ tone: "success", title: "Blocked time removed" });
  }

  return (
    <div className="flex h-[calc(100dvh-4rem)] min-h-[32rem] flex-col gap-3 p-3 md:p-4">
      <h1 className="sr-only">Calendar</h1>

      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-1">
          <Button variant="secondary" aria-label="Previous" onClick={() => handle.current?.prev()}>
            <span aria-hidden>&lsaquo;</span>
          </Button>
          <Button variant="secondary" onClick={() => handle.current?.today()}>
            Today
          </Button>
          <Button variant="secondary" aria-label="Next" onClick={() => handle.current?.next()}>
            <span aria-hidden>&rsaquo;</span>
          </Button>
        </div>
        <p
          aria-live="polite"
          className="order-last min-w-0 basis-full truncate text-base font-semibold md:order-none md:basis-0 md:flex-1"
        >
          {title}
          {loading ? (
            <span className="ml-2 text-xs font-normal text-stone-500">Loading…</span>
          ) : null}
        </p>
        <Button className="ml-auto md:ml-0" onClick={openCreateNow}>
          <span aria-hidden>+</span> New
        </Button>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Chips<CalendarViewName>
          label="Calendar view"
          options={VIEW_OPTIONS}
          value={activeView}
          onChange={(next) => {
            setView(next);
            handle.current?.changeView(next);
          }}
          className="flex-none gap-1.5"
        />
        {resources.locations.length > 1 ? (
          <Select
            aria-label="Location"
            value={locationId}
            onChange={(e) => setLocationId(e.target.value)}
            className="w-auto min-w-0 flex-1 md:flex-none"
          >
            <option value="">All locations</option>
            {resources.locations.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </Select>
        ) : null}
        {resources.staff.length > 1 ? (
          <Select
            aria-label="Stylist"
            value={staffId}
            onChange={(e) => setStaffId(e.target.value)}
            className="w-auto min-w-0 flex-1 md:flex-none"
          >
            <option value="">All stylists</option>
            {resources.staff.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </Select>
        ) : null}
      </div>

      <div className="min-h-0 flex-1 rounded-xl border border-stone-200 bg-white p-1">
        <CalendarView
          handleRef={handle}
          resources={resources}
          locationId={locationId}
          staffId={staffId}
          initialView={defaultView}
          onTitle={handleTitle}
          onLoading={setLoading}
          onLoadError={handleLoadError}
          onCreateAt={openCreate}
          onOpenBooking={setBookingId}
          onOpenBlock={setBlock}
          onReschedule={requestMove}
        />
      </div>

      <BookingSheet
        bookingId={bookingId}
        timezone={resources.timezone}
        onClose={() => setBookingId(null)}
        onChanged={refetch}
      />

      <CreateSheet
        open={createDefaults !== null}
        defaults={createDefaults}
        resources={resources}
        onClose={() => setCreateDefaults(null)}
        onCreated={refetch}
      />

      <Dialog open={pendingMove !== null} onClose={cancelMove} title="Move booking?">
        {pendingMove ? (
          <>
            <p className="text-sm text-stone-700">
              Move {pendingMove.clientName} to{" "}
              <strong>
                {formatDateTime(pendingMove.newStart.toISOString(), resources.timezone)}
              </strong>
              ?
            </p>
            <Switch
              checked={notifyMove}
              onChange={setNotifyMove}
              label="Notify the client"
              description="Sends them the new time by email and SMS."
            />
            <div className="flex gap-2">
              <Button variant="secondary" className="flex-1" disabled={busy} onClick={cancelMove}>
                Leave where it was
              </Button>
              <Button className="flex-1" loading={busy} onClick={() => void confirmMove()}>
                Move
              </Button>
            </div>
          </>
        ) : null}
      </Dialog>

      <Dialog
        open={block !== null}
        onClose={() => setBlock(null)}
        title={block?.kind === "external" ? "Busy in Google Calendar" : "Blocked time"}
      >
        {block ? (
          <>
            <p className="text-sm text-stone-700">
              {block.kind === "external"
                ? "This time is blocked by an event in your Google Calendar. Change it there and it will update here."
                : (block.reason ?? "No reason given.")}
            </p>
            <div className="flex gap-2">
              <Button variant="secondary" className="flex-1" onClick={() => setBlock(null)}>
                Close
              </Button>
              {block.kind === "block" ? (
                <Button
                  variant="danger"
                  className="flex-1"
                  loading={busy}
                  onClick={() => void removeBlock()}
                >
                  Remove block
                </Button>
              ) : null}
            </div>
          </>
        ) : null}
      </Dialog>
    </div>
  );
}
