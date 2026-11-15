"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { addDays } from "@/lib/public-api-time";
import type { CatalogData } from "@/lib/public-api-types";
import { createApiClient } from "../flow/api-client";
import { CheckField, TextField } from "../ui/Field";
import { ArrowRight } from "../ui/icons";
import { ErrorPanel, Notice } from "../ui/Notice";
import { PublicFrame } from "../ui/PublicFrame";
import { TurnstileWidget } from "../ui/TurnstileWidget";
import {
  buildJoinRequest,
  initialForm,
  toggleWeekday,
  validateJoin,
  type JoinErrors,
  type JoinForm,
  type TimeOfDay,
} from "./form";
import { createWaitlistClient } from "./waitlist-api";
import "./waitlist.css";

const TURNSTILE_SITE_KEY = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY;

/** Monday first, as people read a week. */
const DAYS: ReadonlyArray<{ value: number; label: string }> = [
  { value: 1, label: "Mon" },
  { value: 2, label: "Tue" },
  { value: 3, label: "Wed" },
  { value: 4, label: "Thu" },
  { value: 5, label: "Fri" },
  { value: 6, label: "Sat" },
  { value: 0, label: "Sun" },
];

export interface JoinWaitlistViewProps {
  locationId?: string;
  serviceIds: string[];
  date?: string;
  staffId?: string;
}

type Load =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; catalog: CatalogData };

export function JoinWaitlistView(props: JoinWaitlistViewProps) {
  const api = useMemo(() => createApiClient(), []);
  const [load, setLoad] = useState<Load>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    void api.catalog().then((result) => {
      if (cancelled) return;
      setLoad(
        result.ok
          ? { status: "ready", catalog: result.data }
          : { status: "error", message: result.error.message },
      );
    });
    return () => {
      cancelled = true;
    };
  }, [api, attempt]);

  return (
    <PublicFrame>
      {() => (
        <div className="rk-wl">
          <h1 className="rk-wl__title rk-display">
            Join the waitlist<span className="rk-masthead__dot">.</span>
          </h1>
          {load.status === "loading" ? (
            <p className="rk-wl__lede" role="status">
              <span className="rk-spinner" aria-hidden="true" /> Loading…
            </p>
          ) : null}
          {load.status === "error" ? (
            <ErrorPanel message={load.message} onRetry={() => setAttempt((n) => n + 1)} />
          ) : null}
          {load.status === "ready" ? <Ready {...props} catalog={load.catalog} /> : null}
        </div>
      )}
    </PublicFrame>
  );
}

function Ready({
  locationId,
  serviceIds,
  date,
  staffId,
  catalog,
}: JoinWaitlistViewProps & { catalog: CatalogData }) {
  const location = catalog.locations.find((l) => l.id === locationId);
  const services = serviceIds
    .map((id) => location?.services.find((s) => s.id === id))
    .filter((s): s is NonNullable<typeof s> => Boolean(s));

  if (!location || services.length === 0 || services.length !== serviceIds.length) {
    return (
      <>
        <p className="rk-wl__lede">
          Choose your services first, then we&apos;ll take you back here if there are no times.
        </p>
        <div className="rk-actions">
          <Link className="rk-btn" href="/book">
            Choose services <ArrowRight />
          </Link>
        </div>
      </>
    );
  }
  return (
    <JoinForm
      catalog={catalog}
      locationId={location.id}
      locationName={location.name}
      serviceNames={services.map((s) => s.name)}
      serviceIds={services.map((s) => s.id)}
      date={date}
      staffId={staffId}
    />
  );
}

interface JoinFormProps {
  catalog: CatalogData;
  locationId: string;
  locationName: string;
  serviceNames: string[];
  serviceIds: string[];
  date?: string;
  staffId?: string;
}

function JoinForm({
  catalog,
  locationId,
  locationName,
  serviceNames,
  serviceIds,
  date,
  staffId,
}: JoinFormProps) {
  const client = useMemo(() => createWaitlistClient(), []);
  const [form, setForm] = useState<JoinForm>(() => initialForm(catalog.today, date));
  const [errors, setErrors] = useState<JoinErrors>({});
  const [serverError, setServerError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [resetKey, setResetKey] = useState(0);
  const summary = useRef<HTMLDivElement>(null);
  const horizon = addDays(catalog.today, catalog.maxAdvanceDays);
  const errorCount = Object.keys(errors).length;

  useEffect(() => {
    if (errorCount > 0) summary.current?.focus();
  }, [errorCount]);

  const patch = (change: Partial<JoinForm>) => setForm((f) => ({ ...f, ...change }));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (submitting) return;
    const found = validateJoin(form, catalog.today, horizon);
    setErrors(found);
    setServerError(null);
    if (Object.keys(found).length > 0) return;

    setSubmitting(true);
    const result = await client.join(
      buildJoinRequest(form, { locationId, serviceIds, staffId }, token ?? undefined),
    );
    setSubmitting(false);
    if (result.ok) {
      setDone(result.data.leaveToken);
      return;
    }
    setResetKey((n) => n + 1);
    setErrors(result.error.fieldErrors ?? {});
    setServerError(result.error.message);
  };

  if (done) {
    return (
      <>
        <p className="rk-wl__lede" role="status">
          You&apos;re on the waitlist. If a time opens up that suits you, we&apos;ll email and text
          you a link. The first person to pay the deposit gets it.
        </p>
        <div className="rk-actions">
          <Link className="rk-btn rk-btn--ghost" href={`/waitlist/leave/${done}`}>
            Leave the waitlist
          </Link>
          <Link className="rk-btn" href="/book">
            Back to booking <ArrowRight />
          </Link>
        </div>
      </>
    );
  }

  return (
    <form className="rk-form" noValidate onSubmit={submit} aria-busy={submitting}>
      <p className="rk-wl__lede">
        No time that suits? Tell us when you&apos;re free and we&apos;ll message you if one opens
        up. You&apos;ll only hear from us about openings, and you can leave any time.
      </p>
      <div className="rk-wl__selection">
        <strong>{serviceNames.join(" + ")}</strong>
        <span>{locationName}</span>
      </div>

      {errorCount > 0 || serverError ? (
        <div ref={summary} tabIndex={-1} className="rk-notice rk-notice--error" role="alert">
          <div>
            <strong>{serverError ?? "Please fix the highlighted fields."}</strong>
          </div>
        </div>
      ) : null}

      <fieldset className="rk-fieldset">
        <legend className="rk-fieldset__legend">When suits you</legend>
        <div className="rk-fields rk-fields--2">
          <DateField
            id="earliestDate"
            label="From"
            min={catalog.today}
            max={horizon}
            value={form.earliestDate}
            error={errors.earliestDate}
            onChange={(earliestDate) => patch({ earliestDate })}
          />
          <DateField
            id="latestDate"
            label="Until"
            min={catalog.today}
            max={horizon}
            value={form.latestDate}
            error={errors.latestDate}
            onChange={(latestDate) => patch({ latestDate })}
          />
        </div>
        <div className="rk-field" style={{ marginTop: "var(--rk-s-4)" }}>
          <label className="rk-field__label" htmlFor="timeOfDay">
            <span>Time of day</span>
          </label>
          <select
            id="timeOfDay"
            className="rk-input rk-wl__select"
            value={form.timeOfDay}
            onChange={(e) => patch({ timeOfDay: e.target.value as TimeOfDay })}
          >
            <option value="any">Any time</option>
            <option value="morning">Mornings</option>
            <option value="afternoon">Afternoons</option>
          </select>
        </div>
      </fieldset>

      <fieldset className="rk-fieldset">
        <legend className="rk-fieldset__legend">Days of the week (none ticked = any day)</legend>
        <div className="rk-wl__days">
          {DAYS.map((day) => (
            <CheckField
              key={day.value}
              id={`day-${day.value}`}
              checked={form.weekdays.includes(day.value)}
              onChange={() => patch({ weekdays: toggleWeekday(form.weekdays, day.value) })}
            >
              {day.label}
            </CheckField>
          ))}
        </div>
      </fieldset>

      <fieldset className="rk-fieldset">
        <legend className="rk-fieldset__legend">About you</legend>
        <div className="rk-fields rk-fields--2">
          <TextField
            id="firstName"
            label="First name"
            autoComplete="given-name"
            required
            value={form.firstName}
            error={errors["client.firstName"]}
            onChange={(firstName) => patch({ firstName })}
          />
          <TextField
            id="lastName"
            label="Last name"
            autoComplete="family-name"
            required
            value={form.lastName}
            error={errors["client.lastName"]}
            onChange={(lastName) => patch({ lastName })}
          />
          <TextField
            id="email"
            label="Email"
            type="email"
            inputMode="email"
            autoComplete="email"
            required
            value={form.email}
            hint="We'll email you if a time opens."
            error={errors["client.email"]}
            onChange={(email) => patch({ email })}
          />
          <TextField
            id="phone"
            label="Mobile"
            type="tel"
            inputMode="tel"
            autoComplete="tel"
            required
            value={form.phone}
            hint="We'll text you too, so you can be first."
            error={errors["client.phone"]}
            onChange={(phone) => patch({ phone })}
          />
        </div>
        <CheckField
          id="marketing"
          checked={form.marketingOptIn}
          onChange={(marketingOptIn) => patch({ marketingOptIn })}
        >
          Send me news and offers as well (optional).
        </CheckField>
      </fieldset>

      <TurnstileWidget siteKey={TURNSTILE_SITE_KEY} resetKey={resetKey} onToken={setToken} />
      <Notice>
        We&apos;ll only message you about openings. Every message has a link to leave the waitlist.
      </Notice>
      <div className="rk-actions">
        <button type="submit" className="rk-btn" disabled={submitting}>
          {submitting ? "Joining…" : "Join the waitlist"}
          {submitting ? null : <ArrowRight />}
        </button>
      </div>
    </form>
  );
}

interface DateFieldProps {
  id: string;
  label: string;
  min: string;
  max: string;
  value: string;
  error?: string;
  onChange: (value: string) => void;
}

function DateField({ id, label, min, max, value, error, onChange }: DateFieldProps) {
  return (
    <div className="rk-field">
      <label className="rk-field__label" htmlFor={id}>
        <span>{label}</span>
      </label>
      <input
        id={id}
        name={id}
        type="date"
        className="rk-input"
        required
        min={min}
        max={max}
        value={value}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${id}-error` : undefined}
        onChange={(e) => onChange(e.target.value)}
      />
      {error ? (
        <p className="rk-field__error" id={`${id}-error`}>
          {error}
        </p>
      ) : null}
    </div>
  );
}
