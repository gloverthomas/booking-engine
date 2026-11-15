"use client";

import { useCallback, useImperativeHandle, useMemo, useRef, type Ref } from "react";
import FullCalendar from "@fullcalendar/react";
import timeGridPlugin from "@fullcalendar/timegrid";
import dayGridPlugin from "@fullcalendar/daygrid";
import interactionPlugin, { type DateClickArg } from "@fullcalendar/interaction";
import type {
  DatesSetArg,
  DateSelectArg,
  EventClickArg,
  EventContentArg,
  EventSourceFuncArg,
  EventInput,
} from "@fullcalendar/core";
import type { CalendarEvent, CalendarResources } from "@/server/admin/types";
import { getJson } from "./api";
import { STATUS_LABEL } from "./format";
import { toFullCalendarEvent } from "./fc-events";
import { staffQuery } from "./staff-filter";
import { fromWallClock, toWallClock } from "./wallclock";
import "./calendar.css";

export type CalendarViewName = "timeGridDay" | "timeGridThreeDay" | "timeGridWeek";

export interface CalendarHandle {
  prev: () => void;
  next: () => void;
  today: () => void;
  changeView: (view: CalendarViewName) => void;
  refetch: () => void;
  /** Optimistically drop an event (by FullCalendar id) before the server confirms. */
  removeEvent: (id: string) => void;
}

export interface RescheduleRequest {
  bookingId: string;
  clientName: string;
  newStart: Date;
  /** Put the event back where it was (cancelled prompt or failed save). */
  revert: () => void;
}

export interface CalendarViewProps {
  resources: CalendarResources;
  locationId: string;
  /** Stylists to show. Empty means everyone the viewer may see. */
  staffIds: readonly string[];
  initialView: CalendarViewName;
  handleRef: Ref<CalendarHandle>;
  onTitle: (title: string, view: CalendarViewName) => void;
  onLoading: (loading: boolean) => void;
  onLoadError: (message: string) => void;
  onCreateAt: (start: Date, end: Date) => void;
  onOpenBooking: (bookingId: string) => void;
  onOpenBlock: (block: { id: string; kind: "block" | "external"; reason: string | null }) => void;
  onReschedule: (request: RescheduleRequest) => void;
}

/** Ignore the second of a click + select pair fired for the same tap. */
const DEDUPE_MS = 400;

export default function CalendarView(props: CalendarViewProps) {
  const {
    resources,
    locationId,
    staffIds,
    initialView,
    handleRef,
    onTitle,
    onLoading,
    onLoadError,
    onCreateAt,
    onOpenBooking,
    onOpenBlock,
    onReschedule,
  } = props;
  const { timezone, slotStepMin } = resources;
  const calendarRef = useRef<FullCalendar>(null);
  const lastCreate = useRef(0);

  useImperativeHandle(
    handleRef,
    () => ({
      prev: () => calendarRef.current?.getApi().prev(),
      next: () => calendarRef.current?.getApi().next(),
      today: () => calendarRef.current?.getApi().today(),
      changeView: (view) => calendarRef.current?.getApi().changeView(view),
      refetch: () => calendarRef.current?.getApi().refetchEvents(),
      removeEvent: (id) => calendarRef.current?.getApi().getEventById(id)?.remove(),
    }),
    [],
  );

  const locationIds = useMemo(() => resources.locations.map((l) => l.id), [resources.locations]);
  const staffLookup = useMemo(
    () => new Map(resources.staff.map((s) => [s.id, { name: s.name, colour: s.colour }])),
    [resources.staff],
  );
  // A string key so a new array with the same people does not refetch.
  const staffKey = staffQuery(staffIds) ?? "";

  const loadEvents = useCallback(
    (
      info: EventSourceFuncArg,
      success: (events: EventInput[]) => void,
      failure: (error: Error) => void,
    ) => {
      const query = new URLSearchParams({
        from: fromWallClock(info.start, timezone).toISOString(),
        to: fromWallClock(info.end, timezone).toISOString(),
      });
      if (locationId) query.set("locationId", locationId);
      if (staffKey) query.set("staffIds", staffKey);
      getJson<{ events: CalendarEvent[] }>(`/calendar/events?${query.toString()}`)
        .then((body) =>
          success(
            body.events.map((e) => toFullCalendarEvent(e, timezone, locationIds, staffLookup)),
          ),
        )
        .catch((error: unknown) => {
          const message = error instanceof Error ? error.message : "Could not load the calendar.";
          onLoadError(message);
          failure(error instanceof Error ? error : new Error(message));
        });
    },
    [timezone, locationId, staffKey, locationIds, staffLookup, onLoadError],
  );

  const openCreate = useCallback(
    (wallStart: Date, wallEnd: Date) => {
      const now = Date.now();
      if (now - lastCreate.current < DEDUPE_MS) return;
      lastCreate.current = now;
      onCreateAt(fromWallClock(wallStart, timezone), fromWallClock(wallEnd, timezone));
    },
    [onCreateAt, timezone],
  );

  const handleDateClick = useCallback(
    (arg: DateClickArg) => {
      if (arg.allDay) return;
      const end = new Date(arg.date.getTime() + 45 * 60_000);
      openCreate(arg.date, end);
    },
    [openCreate],
  );

  const handleSelect = useCallback(
    (arg: DateSelectArg) => {
      openCreate(arg.start, arg.end);
      calendarRef.current?.getApi().unselect();
    },
    [openCreate],
  );

  const handleEventClick = useCallback(
    (arg: EventClickArg) => {
      const props = arg.event.extendedProps as {
        kind: string;
        blockId?: string;
        reason?: string | null;
      };
      if (props.kind === "booking") {
        onOpenBooking(arg.event.id);
      } else if (props.blockId) {
        onOpenBlock({
          id: props.blockId,
          kind: props.kind === "external" ? "external" : "block",
          reason: props.reason ?? null,
        });
      }
    },
    [onOpenBooking, onOpenBlock],
  );

  const handleDatesSet = useCallback(
    (arg: DatesSetArg) => onTitle(arg.view.title, arg.view.type as CalendarViewName),
    [onTitle],
  );

  const renderEvent = useCallback((arg: EventContentArg) => {
    const x = arg.event.extendedProps as {
      kind: string;
      status?: keyof typeof STATUS_LABEL;
      services?: string[];
      staffName?: string | null;
    };
    if (x.kind !== "booking") {
      return (
        <div className="cal-ev-inner">
          <span className="cal-ev-name">{arg.event.title}</span>
        </div>
      );
    }
    const sub = [
      x.staffName ?? null,
      x.status && x.status !== "confirmed" ? STATUS_LABEL[x.status] : null,
      x.services?.join(", ") || null,
    ]
      .filter(Boolean)
      .join(" · ");
    return (
      <div className="cal-ev-inner">
        <span className="cal-ev-name">{arg.event.title}</span>
        {sub ? <span className="cal-ev-sub">{sub}</span> : null}
      </div>
    );
  }, []);

  const handleEventDrop = useCallback(
    (arg: { event: { id: string; title: string; start: Date | null }; revert: () => void }) => {
      if (!arg.event.start) {
        arg.revert();
        return;
      }
      onReschedule({
        bookingId: arg.event.id,
        clientName: arg.event.title,
        newStart: fromWallClock(arg.event.start, timezone),
        revert: arg.revert,
      });
    },
    [onReschedule, timezone],
  );

  const step = `00:${String(slotStepMin).padStart(2, "0")}:00`;

  return (
    <div className="admin-calendar h-full">
      <FullCalendar
        ref={calendarRef}
        plugins={[timeGridPlugin, dayGridPlugin, interactionPlugin]}
        initialView={initialView}
        views={{ timeGridThreeDay: { type: "timeGrid", duration: { days: 3 } } }}
        headerToolbar={false}
        timeZone="UTC"
        now={() => toWallClock(new Date(), timezone)}
        nowIndicator
        firstDay={1}
        height="100%"
        allDaySlot={false}
        slotDuration={step}
        snapDuration={step}
        slotLabelInterval="01:00:00"
        slotMinTime="06:00:00"
        slotMaxTime="22:00:00"
        scrollTime="08:00:00"
        slotLabelFormat={{ hour: "numeric", minute: "2-digit", hour12: true }}
        dayHeaderFormat={{ weekday: "short", day: "numeric" }}
        eventTimeFormat={{ hour: "numeric", minute: "2-digit", hour12: true }}
        selectable
        selectMirror
        unselectAuto={false}
        longPressDelay={350}
        eventLongPressDelay={350}
        selectLongPressDelay={350}
        editable={resources.viewer.editBookings}
        eventDurationEditable={false}
        slotEventOverlap={false}
        events={loadEvents}
        loading={onLoading}
        datesSet={handleDatesSet}
        dateClick={handleDateClick}
        select={handleSelect}
        eventClick={handleEventClick}
        eventDrop={handleEventDrop}
        eventContent={renderEvent}
      />
    </div>
  );
}
