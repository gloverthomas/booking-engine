"use client";

import { useEffect, useRef, type FormEvent } from "react";
import type { CatalogPolicy, CatalogService } from "@/lib/public-api-types";
import type { DetailsErrors, DetailsForm } from "../flow/details";
import { policyBody } from "../flow/policy-copy";
import { CheckField, TextField } from "../ui/Field";

export const DETAILS_FORM_ID = "rk-details-form";

interface DetailsStepProps {
  details: DetailsForm;
  errors: DetailsErrors;
  /** Increments on each submit attempt, so the error summary takes focus every time. */
  attempt: number;
  services: readonly CatalogService[];
  policy: CatalogPolicy;
  welcomeName: string | null;
  onForget: () => void;
  onChange: (patch: Partial<DetailsForm>) => void;
  onSubmit: () => void;
  /** Cloudflare Turnstile slot, rendered just above the policy. */
  captcha: React.ReactNode;
}

export function DetailsStep({
  details,
  errors,
  attempt,
  services,
  policy,
  welcomeName,
  onForget,
  onChange,
  onSubmit,
  captcha,
}: DetailsStepProps) {
  const summary = useRef<HTMLDivElement>(null);
  const errorCount = Object.keys(errors).length;

  useEffect(() => {
    if (attempt > 0 && errorCount > 0) summary.current?.focus();
  }, [attempt, errorCount]);

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    onSubmit();
  };

  const intakeQuestions = services.flatMap((svc) =>
    svc.intakeQuestions.map((q) => ({ ...q, service: svc.name })),
  );

  return (
    <form id={DETAILS_FORM_ID} className="rk-form" noValidate onSubmit={handleSubmit}>
      {errorCount > 0 ? (
        <div ref={summary} tabIndex={-1} className="rk-notice rk-notice--error" role="alert">
          <div>
            <strong>
              {errorCount === 1 ? "One thing needs fixing" : `${errorCount} things need fixing`}:
            </strong>
            <ul>
              {Object.entries(errors).map(([key, message]) => (
                <li key={key}>{message}</li>
              ))}
            </ul>
          </div>
        </div>
      ) : null}

      {welcomeName ? (
        <p className="rk-welcome" role="status">
          <span>
            Welcome back, <strong>{welcomeName}</strong>. We&apos;ve filled in your details.
          </span>
          <button type="button" className="rk-link-btn" onClick={onForget}>
            Not you? Clear
          </button>
        </p>
      ) : null}

      <fieldset className="rk-fieldset">
        <legend className="rk-fieldset__legend">About you</legend>
        <div className="rk-fields rk-fields--2">
          <TextField
            id="firstName"
            label="First name"
            autoComplete="given-name"
            required
            value={details.firstName}
            error={errors["client.firstName"]}
            onChange={(firstName) => onChange({ firstName })}
          />
          <TextField
            id="lastName"
            label="Last name"
            autoComplete="family-name"
            required
            value={details.lastName}
            error={errors["client.lastName"]}
            onChange={(lastName) => onChange({ lastName })}
          />
          <TextField
            id="email"
            label="Email"
            type="email"
            inputMode="email"
            autoComplete="email"
            required
            value={details.email}
            hint="Your confirmation and manage link go here."
            error={errors["client.email"]}
            onChange={(email) => onChange({ email })}
          />
          <TextField
            id="phone"
            label="Mobile"
            type="tel"
            inputMode="tel"
            autoComplete="tel"
            required
            value={details.phone}
            hint="We'll text your confirmation and a reminder."
            error={errors["client.phone"]}
            onChange={(phone) => onChange({ phone })}
          />
          <TextField
            id="pronouns"
            label="Pronouns"
            optional
            maxLength={40}
            value={details.pronouns}
            onChange={(pronouns) => onChange({ pronouns })}
          />
          <TextField
            id="otherPhone"
            label="Other phone"
            type="tel"
            inputMode="tel"
            autoComplete="tel"
            optional
            value={details.otherPhone}
            error={errors.otherPhone}
            onChange={(otherPhone) => onChange({ otherPhone })}
          />
          <TextField
            id="company"
            label="Company"
            autoComplete="organization"
            optional
            maxLength={100}
            wide
            value={details.company}
            onChange={(company) => onChange({ company })}
          />
        </div>
      </fieldset>

      {intakeQuestions.length > 0 ? (
        <fieldset className="rk-fieldset">
          <legend className="rk-fieldset__legend">A few questions</legend>
          <div className="rk-fields">
            {intakeQuestions.map((q) => (
              <TextField
                key={q.id}
                id={`intake-${q.id}`}
                label={q.label}
                hint={`For: ${q.service}`}
                optional={!q.required}
                required={q.required}
                multiline
                maxLength={500}
                value={details.intakeAnswers[q.id] ?? ""}
                error={errors[`intakeAnswers.${q.id}`]}
                onChange={(answer) =>
                  onChange({ intakeAnswers: { ...details.intakeAnswers, [q.id]: answer } })
                }
              />
            ))}
          </div>
        </fieldset>
      ) : null}

      <fieldset className="rk-fieldset">
        <legend className="rk-fieldset__legend">Anything else</legend>
        <div className="rk-fields">
          <TextField
            id="comments"
            label="Comments for Ryan"
            optional
            multiline
            maxLength={1000}
            value={details.comments}
            onChange={(comments) => onChange({ comments })}
          />
          <CheckField
            id="bookedForOther"
            checked={details.bookedForOther}
            onChange={(bookedForOther) => onChange({ bookedForOther })}
          >
            I&apos;m booking for someone else
            <small>Use your own contact details above so we can reach you.</small>
          </CheckField>
          <CheckField
            id="marketingOptIn"
            checked={details.marketingOptIn}
            onChange={(marketingOptIn) => onChange({ marketingOptIn })}
          >
            Send me news and offers
            <small>Optional. Booking messages are always sent regardless.</small>
          </CheckField>
        </div>
      </fieldset>

      {captcha}

      <fieldset className="rk-fieldset">
        <legend className="rk-fieldset__legend">Cancellation policy</legend>
        <div className={`rk-policy${errors.policyAccepted ? " is-invalid" : ""}`}>
          <div
            className="rk-policy__text"
            tabIndex={0}
            role="region"
            aria-label="Cancellation policy text"
          >
            {policyBody(policy)}
          </div>
          <CheckField
            id="policyAccepted"
            required
            checked={details.policyAccepted}
            error={errors.policyAccepted}
            onChange={(policyAccepted) => onChange({ policyAccepted })}
          >
            <strong>I&apos;ve read and agree to the cancellation policy.</strong>
          </CheckField>
        </div>
      </fieldset>
    </form>
  );
}
