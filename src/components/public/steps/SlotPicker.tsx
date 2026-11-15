"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AvailabilityData, SlotDto } from "@/lib/public-api-types";
import {
  addDays,
  addMonths,
  formatDayHeading,
  formatMonthHeading,
  monthEnd,
  monthStart,
} from "@/lib/public-api-time";
import type { ApiClient } from "../flow/api-client";
import { WEEKDAY_LABELS, buildMonthGrid, canGoNextMonth, canGoPrevMonth } from "../flow/calendar";
import { JoinWaitlistCta } from "../waitlist/JoinWaitlistCta";
import { ChevronLeft, ChevronRight } from "../ui/icons";

interface SlotPickerProps {
  api: ApiClient;
  locationId: string;
  serviceIds: readonly string[];
  /** Only show this stylist's times (a chosen stylist, or the one a booking is with). */
  staffId?: string;
  /** Offer the waitlist when a day or the whole month has no times. Off for rescheduling. */
  waitlistEnabled?: boolean;
  today: string;
  maxAdvanceDays: number;
  timezone: string;
  date: string | null;
  slot: SlotDto | null;
  onDate: (date: string) => void;
  onSlot: (slot: SlotDto) => void;
}

type MonthState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; data: AvailabilityData };

const LOADING: MonthState = { status: "loading" };

/**
 * Month grid with availability dots, plus Morning/Afternoon time lists for the chosen day.
 * Availability is cached per month for the lifetime of the component: give it a `key` that
 * changes with the selection (services, location) or after a lost slot to start fresh.
 */
export function SlotPicker(props: SlotPickerProps) {
  const {
    api,
    locationId,
    serviceIds,
    staffId,
    waitlistEnabled = false,
    today,
    maxAdvanceDays,
    timezone,
    date,
    slot,
  } = props;
  const maxDate = addDays(today, maxAdvanceDays);
  const [month, setMonth] = useState(() => monthStart(date ?? today));
  const [months, setMonths] = useState<Record<string, MonthState>>({});
  const requested = useRef(new Set<string>());

  const load = useCallback(
    async (target: string) => {
      if (requested.current.has(target)) return;
      requested.current.add(target);
      const result = await api.availability({
        locationId,
        serviceIds: [...serviceIds],
        staffId,
        fromDate: target < today ? today : target,
        toDate: monthEnd(target),
      });
      setMonths((prev) => ({
        ...prev,
        [target]: result.ok
          ? { status: "ready", data: result.data }
          : { status: "error", message: result.error.message },
      }));
      if (!result.ok) requested.current.delete(target);
    },
    [api, locationId, serviceIds, staffId, today],
  );

  useEffect(() => {
    void load(month);
  }, [load, month]);

  const current: MonthState = months[month] ?? LOADING;

  const availableDates = useMemo(
    () => new Set(current.status === "ready" ? current.data.days.map((d) => d.date) : []),
    [current],
  );
  const weeks = useMemo(
    () => buildMonthGrid({ month, availableDates, today, maxDate }),
    [month, availableDates, today, maxDate],
  );
  const dayData =
    current.status === "ready" && date ? current.data.days.find((d) => d.date === date) : undefined;

  const goTo = (target: string) => {
    setMonth(target);
  };

  const nextMonthValue = addMonths(month, 1);
  const noTimesThisMonth = current.status === "ready" && current.data.days.length === 0;

  return (
    <div className="rk-picker">
      <div>
        <div className={`rk-cal${current.status === "loading" ? " is-loading" : ""}`}>
          <div className="rk-cal__head">
            <button
              type="button"
              className="rk-cal__nav"
              onClick={() => goTo(addMonths(month, -1))}
              disabled={!canGoPrevMonth(month, today)}
              aria-label="Previous month"
            >
              <ChevronLeft />
            </button>
            <h3 className="rk-cal__title" aria-live="polite">
              {formatMonthHeading(month)}
            </h3>
            <button
              type="button"
              className="rk-cal__nav"
              onClick={() => goTo(nextMonthValue)}
              disabled={!canGoNextMonth(month, maxDate)}
              aria-label="Next month"
            >
              <ChevronRight />
            </button>
          </div>

          <div className="rk-cal__weekdays" aria-hidden="true">
            {WEEKDAY_LABELS.map((d) => (
              <span key={d} className="rk-cal__weekday">
                {d}
              </span>
            ))}
          </div>

          <div role="group" aria-label={`Days in ${formatMonthHeading(month)}`}>
            {weeks.map((week, wi) => (
              <div className="rk-cal__week" key={wi}>
                {week.map((cell, ci) => (
                  <div className="rk-cal__cell" key={cell?.date ?? `pad-${wi}-${ci}`}>
                    {cell ? (
                      <button
                        type="button"
                        className={`rk-cal__day${cell.available ? " is-available" : ""}${cell.isToday ? " is-today" : ""}`}
                        disabled={cell.disabled}
                        aria-pressed={date === cell.date}
                        aria-label={`${formatDayHeading(cell.date)}${cell.available ? ", times available" : ", unavailable"}`}
                        onClick={() => props.onDate(cell.date)}
                      >
                        <span className="rk-cal__num">{cell.day}</span>
                      </button>
                    ) : null}
                  </div>
                ))}
              </div>
            ))}
          </div>

          {current.status === "error" ? (
            <p className="rk-cal__status" role="alert">
              {current.message}{" "}
              <button
                type="button"
                className="rk-link-btn"
                onClick={() => {
                  requested.current.delete(month);
                  setMonths((prev) => ({ ...prev, [month]: { status: "loading" } }));
                  void load(month);
                }}
              >
                Try again
              </button>
            </p>
          ) : null}

          {noTimesThisMonth ? (
            <>
              <p className="rk-cal__status" role="status">
                No times left this month.{" "}
                {canGoNextMonth(month, maxDate) ? (
                  <button
                    type="button"
                    className="rk-link-btn"
                    onClick={() => goTo(nextMonthValue)}
                  >
                    Check next month
                  </button>
                ) : null}
              </p>
              {waitlistEnabled ? (
                <div className="rk-waitlist">
                  <JoinWaitlistCta
                    locationId={locationId}
                    serviceIds={[...serviceIds]}
                    staffId={staffId}
                  />
                </div>
              ) : null}
            </>
          ) : null}

          <div className="rk-cal__legend">
            <i aria-hidden="true" /> Times available
          </div>
        </div>
      </div>

      <div className="rk-times" aria-live="polite">
        {!date ? (
          <p className="rk-times__empty">Choose a day to see available times.</p>
        ) : !dayData ? (
          <div className="rk-times__empty">
            <p>
              {current.status === "loading"
                ? "Loading times…"
                : "No times on this day. Try another."}
            </p>
            {current.status === "ready" && waitlistEnabled && !noTimesThisMonth ? (
              <div className="rk-waitlist">
                <JoinWaitlistCta
                  locationId={locationId}
                  serviceIds={[...serviceIds]}
                  date={date}
                  staffId={staffId}
                />
              </div>
            ) : null}
          </div>
        ) : (
          <>
            <h3 className="rk-times__heading">{formatDayHeading(date)}</h3>
            <TimeGroup
              label="Morning"
              slots={dayData.morning}
              selected={slot}
              onPick={props.onSlot}
            />
            <TimeGroup
              label="Afternoon"
              slots={dayData.afternoon}
              selected={slot}
              onPick={props.onSlot}
            />
            <p className="rk-times__tz">Times are shown in {cityOf(timezone)} time.</p>
          </>
        )}
      </div>
    </div>
  );
}

function cityOf(timezone: string): string {
  return timezone.split("/").pop()?.replace(/_/g, " ") ?? timezone;
}

function TimeGroup({
  label,
  slots,
  selected,
  onPick,
}: {
  label: string;
  slots: readonly SlotDto[];
  selected: SlotDto | null;
  onPick: (slot: SlotDto) => void;
}) {
  if (slots.length === 0) return null;
  return (
    <fieldset className="rk-times__group rk-fieldset">
      <legend className="rk-times__legend">{label}</legend>
      <div className="rk-times__grid">
        {slots.map((s) => (
          <button
            key={s.start}
            type="button"
            className="rk-slot"
            aria-pressed={selected?.start === s.start}
            onClick={() => onPick(s)}
          >
            {s.label}
          </button>
        ))}
      </div>
    </fieldset>
  );
}
