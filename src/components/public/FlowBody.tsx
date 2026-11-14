"use client";

import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { CatalogData } from "@/lib/public-api-types";
import type { ApiClient } from "./flow/api-client";
import { startHoldClock, type HoldClock } from "./flow/countdown";
import {
  EMPTY_DETAILS,
  applyRemembered,
  buildHoldRequest,
  toRemembered,
  validateDetails,
  type DetailsErrors,
} from "./flow/details";
import {
  forgetRememberedClient,
  loadRememberedClient,
  saveRememberedClient,
} from "./flow/remembered-client";
import {
  canLeaveStep,
  canVisit,
  flowReducer,
  flowTotals,
  initialStateFor,
  selectedLocation,
  selectedServices,
  stepsFor,
  type FlowState,
  type StepId,
} from "./flow/state";
import { scrollFlowToTop } from "./flow/use-embed";
import { useFlowHistory } from "./flow/use-flow-history";
import { DETAILS_FORM_ID, DetailsStep } from "./steps/DetailsStep";
import { LocationStep } from "./steps/LocationStep";
import { PayStep } from "./steps/PayStep";
import { ServicesStep } from "./steps/ServicesStep";
import { SlotPicker } from "./steps/SlotPicker";
import { HoldCountdown } from "./ui/HoldCountdown";
import { ArrowLeft, ArrowRight } from "./ui/icons";
import { Notice } from "./ui/Notice";
import { Recap } from "./ui/Recap";
import { StepRail, STEP_LABELS } from "./ui/StepRail";
import { Ticket } from "./ui/Ticket";
import { TurnstileWidget } from "./ui/TurnstileWidget";

const TURNSTILE_SITE_KEY = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY;

const TITLES: Record<StepId, string> = {
  location: "Where to?",
  services: "Pick your services",
  time: "Pick a time",
  details: "Your details",
  pay: "Pay your deposit",
};

const LEDES: Partial<Record<StepId, string>> = {
  location: "Choose the salon you'd like to visit.",
  services: "Choose one or more. We'll add up the time and the price as you go.",
  time: "Choose a day, then a time that suits.",
};

interface FlowBodyProps {
  api: ApiClient;
  catalog: CatalogData;
  /** Re-fetch the catalog (used when the cancellation policy changed under the visitor). */
  onReloadCatalog: () => void;
  embedded: boolean;
  rootRef: React.RefObject<HTMLDivElement | null>;
}

function initialFor(catalog: CatalogData): FlowState {
  const remembered = loadRememberedClient();
  return initialStateFor(
    catalog,
    remembered ? applyRemembered(EMPTY_DETAILS, remembered) : EMPTY_DETAILS,
  );
}

export function FlowBody({ api, catalog, onReloadCatalog, embedded, rootRef }: FlowBodyProps) {
  const router = useRouter();
  const [state, dispatch] = useReducer(flowReducer, catalog, initialFor);
  const [holdClock, setHoldClock] = useState<HoldClock | null>(null);
  const [errors, setErrors] = useState<DetailsErrors>({});
  const [attempt, setAttempt] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [captchaToken, setCaptchaToken] = useState<string | null>(null);
  const [captchaReset, setCaptchaReset] = useState(0);
  const [pickerEpoch, setPickerEpoch] = useState(0);
  const [welcomeName, setWelcomeName] = useState<string | null>(() => {
    const remembered = loadRememberedClient();
    return remembered?.firstName ? remembered.firstName : null;
  });
  const headingRef = useRef<HTMLHeadingElement>(null);

  const steps = stepsFor(catalog, state);
  const location = selectedLocation(state, catalog);
  const services = selectedServices(state, catalog);
  const totals = flowTotals(state, catalog);
  const hasDeposit = steps.includes("pay");
  const hold = state.hold;
  const timezone = catalog.business.timezone;
  const confirmedPath = (token: string) => `/book/confirmed/${encodeURIComponent(token)}`;

  /* ---- Releasing a hold (Back from payment, or the browser Back button) ---- */

  const release = (to: StepId, notice?: string) => {
    if (state.hold) void api.cancel(state.hold.manageToken, "Client went back before paying");
    setHoldClock(null);
    dispatch({ type: "holdReleased", to, notice });
  };

  const visit = (target: StepId) => {
    if (state.step === "pay" && target !== "pay") {
      release(target);
      return;
    }
    if (canVisit(state, steps, target)) dispatch({ type: "goTo", step: target });
  };

  useFlowHistory(state.step, visit);

  /* ---- Move focus and scroll to the new step ---- */

  const firstRender = useRef(true);
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    headingRef.current?.focus({ preventScroll: true });
    scrollFlowToTop(rootRef.current, embedded);
  }, [state.step, embedded, rootRef]);

  /* ---- Actions ---- */

  const stepIndex = steps.indexOf(state.step);
  const previousStep = stepIndex > 0 ? steps[stepIndex - 1] : null;

  const goBack = () => {
    if (previousStep) visit(previousStep);
  };

  const goNext = () => {
    const next = steps[stepIndex + 1];
    if (next && next !== "pay" && canLeaveStep(state, state.step)) {
      dispatch({ type: "goTo", step: next });
    }
  };

  const handleHoldExpired = useCallback(() => {
    setHoldClock(null);
    setPickerEpoch((n) => n + 1);
    dispatch({
      type: "holdReleased",
      notice: "Your hold ran out before payment. Pick your time again and we'll hold it afresh.",
    });
  }, []);

  const submitDetails = async () => {
    const found = validateDetails(state.details, services);
    setAttempt((n) => n + 1);
    setErrors(found);
    if (Object.keys(found).length > 0 || !state.slot || !state.locationId) return;

    if (TURNSTILE_SITE_KEY && !captchaToken) {
      dispatch({
        type: "notice",
        notice: "Still checking that you're human. Give it a moment and try again.",
      });
      return;
    }

    setSubmitting(true);
    dispatch({ type: "notice", notice: null });
    const result = await api.createHold(
      buildHoldRequest({
        locationId: state.locationId,
        serviceIds: state.serviceIds,
        slotStart: state.slot.start,
        details: state.details,
        policyVersion: catalog.policy.version,
        turnstileToken: captchaToken ?? undefined,
      }),
    );
    // Turnstile tokens are single use: always ask for a fresh one after a submission.
    setCaptchaToken(null);
    setCaptchaReset((n) => n + 1);
    setSubmitting(false);

    if (result.ok) {
      saveRememberedClient(toRemembered(state.details));
      if (result.data.confirmed) {
        router.push(confirmedPath(result.data.manageToken));
        return;
      }
      setHoldClock(startHoldClock(result.data.holdExpiresAt, result.data.serverNow));
      dispatch({ type: "holdCreated", hold: result.data });
      return;
    }

    const { code, message, fieldErrors } = result.error;
    if (code === "slot_taken") {
      setPickerEpoch((n) => n + 1);
      dispatch({ type: "slotLost", notice: message });
    } else if (code === "policy_changed") {
      dispatch({ type: "editDetails", patch: { policyAccepted: false } });
      dispatch({ type: "notice", notice: message });
      onReloadCatalog();
    } else if (code === "validation_failed" && fieldErrors) {
      setErrors(fieldErrors);
      setAttempt((n) => n + 1);
    } else {
      dispatch({ type: "notice", notice: message });
    }
  };

  /* ---- Primary action for the sticky ticket ---- */

  const ticketAction = (() => {
    switch (state.step) {
      case "location":
      case "services":
      case "time": {
        const nextLabel =
          state.step === "location"
            ? "Services"
            : state.step === "services"
              ? "Choose a time"
              : "Your details";
        return (
          <button
            type="button"
            className="rk-btn"
            disabled={!canLeaveStep(state, state.step)}
            onClick={goNext}
          >
            {nextLabel}
            <ArrowRight />
          </button>
        );
      }
      case "details":
        return (
          <button
            type="submit"
            form={DETAILS_FORM_ID}
            className="rk-btn"
            disabled={submitting}
            aria-busy={submitting}
          >
            {submitting ? "Holding your time…" : hasDeposit ? "To payment" : "Confirm booking"}
            {submitting ? null : <ArrowRight />}
          </button>
        );
      case "pay":
        return null;
    }
  })();

  const stepNumber = String(Math.max(stepIndex, 0) + 1).padStart(2, "0");
  const compact = state.step !== "location" && state.step !== "services";

  return (
    <>
      <h1 className={`rk-masthead rk-display${compact ? " rk-masthead--compact" : ""}`}>
        Book an appointment<span className="rk-masthead__dot">.</span>
      </h1>

      <StepRail
        steps={steps}
        current={state.step}
        canVisit={(target) => canVisit(state, steps, target)}
        onVisit={visit}
      />

      <div className="rk-layout">
        <section className="rk-stage" key={state.step} aria-labelledby="rk-step-title">
          {previousStep ? (
            <button type="button" className="rk-stage__back" onClick={goBack}>
              <ArrowLeft size={16} /> Back to {STEP_LABELS[previousStep].toLowerCase()}
            </button>
          ) : null}

          <h2 className="rk-step-title" id="rk-step-title" tabIndex={-1} ref={headingRef}>
            <span className="rk-step-title__num" aria-hidden="true">
              {stepNumber}
            </span>
            {TITLES[state.step]}
          </h2>
          {LEDES[state.step] ? <p className="rk-step-lede">{LEDES[state.step]}</p> : null}

          <div className="rk-step-body">
            {state.notice ? (
              <Notice tone={state.step === "details" || state.step === "time" ? "error" : "info"}>
                {state.notice}
              </Notice>
            ) : null}

            {state.step === "location" ? (
              <LocationStep
                locations={catalog.locations}
                selectedId={state.locationId}
                onSelect={(locationId) => dispatch({ type: "selectLocation", locationId })}
              />
            ) : null}

            {state.step === "services" && location ? (
              <ServicesStep
                services={location.services}
                selectedIds={state.serviceIds}
                onToggle={(serviceId) => dispatch({ type: "toggleService", serviceId })}
              />
            ) : null}

            {state.step === "time" && state.locationId ? (
              <SlotPicker
                key={`${state.locationId}|${state.serviceIds.join(",")}|${pickerEpoch}`}
                api={api}
                locationId={state.locationId}
                serviceIds={state.serviceIds}
                today={catalog.today}
                maxAdvanceDays={catalog.maxAdvanceDays}
                timezone={timezone}
                date={state.date}
                slot={state.slot}
                onDate={(date) => dispatch({ type: "pickDate", date })}
                onSlot={(slot) => dispatch({ type: "pickSlot", slot })}
              />
            ) : null}

            {state.step === "details" && state.slot ? (
              <>
                <Recap
                  whenIso={state.slot.start}
                  timezone={timezone}
                  locationName={location?.name ?? null}
                  serviceNames={services.map((s) => s.name)}
                />
                <DetailsStep
                  details={state.details}
                  errors={errors}
                  attempt={attempt}
                  services={services}
                  policy={catalog.policy}
                  welcomeName={welcomeName}
                  onForget={() => {
                    forgetRememberedClient();
                    setWelcomeName(null);
                    dispatch({
                      type: "editDetails",
                      patch: { ...EMPTY_DETAILS, policyAccepted: state.details.policyAccepted },
                    });
                  }}
                  onChange={(patch) => dispatch({ type: "editDetails", patch })}
                  onSubmit={submitDetails}
                  captcha={
                    <TurnstileWidget
                      siteKey={TURNSTILE_SITE_KEY}
                      resetKey={captchaReset}
                      onToken={setCaptchaToken}
                    />
                  }
                />
              </>
            ) : null}

            {state.step === "pay" && hold && state.slot ? (
              <>
                <Recap
                  whenIso={hold.start}
                  timezone={timezone}
                  locationName={location?.name ?? null}
                  serviceNames={services.map((s) => s.name)}
                />
                {holdClock ? (
                  <HoldCountdown clock={holdClock} onExpire={handleHoldExpired} />
                ) : null}
                <PayStep
                  hold={hold}
                  details={state.details}
                  returnUrl={`${window.location.origin}${confirmedPath(hold.manageToken)}`}
                  expired={holdClock === null}
                  onPaid={() => router.push(confirmedPath(hold.manageToken))}
                />
              </>
            ) : null}
          </div>
        </section>

        <Ticket
          items={services.map((s) => ({ id: s.id, name: s.name, priceCents: s.priceCents }))}
          locationName={location?.name ?? null}
          whenIso={state.hold?.start ?? state.slot?.start ?? null}
          timezone={timezone}
          totalCents={state.hold?.totalCents ?? totals.totalCents}
          durationMin={totals.durationMin}
          depositCents={state.hold?.depositCents ?? totals.depositCents}
          action={ticketAction}
        />
      </div>
    </>
  );
}
