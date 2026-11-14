"use client";

import { useMemo, useState, type FormEvent } from "react";
import { Elements, PaymentElement, useElements, useStripe } from "@stripe/react-stripe-js";
import { loadStripe, type Appearance, type Stripe } from "@stripe/stripe-js";
import { formatAud } from "@/lib/public-api-money";
import type { HoldData } from "@/lib/public-api-types";
import type { DetailsForm } from "../flow/details";
import { ArrowRight } from "../ui/icons";

const PUBLISHABLE_KEY = process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY;

let stripePromise: Promise<Stripe | null> | null = null;
function getStripe(): Promise<Stripe | null> | null {
  if (!PUBLISHABLE_KEY) return null;
  stripePromise ??= loadStripe(PUBLISHABLE_KEY);
  return stripePromise;
}

/** Flat, square Stripe fields that match the underline inputs on the details step. */
const APPEARANCE: Appearance = {
  theme: "flat",
  variables: {
    colorPrimary: "#0b0b0b",
    colorBackground: "#f8d6b6",
    colorText: "#0b0b0b",
    colorTextSecondary: "#5b4636",
    colorDanger: "#b02d08",
    fontFamily: "Archivo, Helvetica Neue, Arial, sans-serif",
    fontSizeBase: "16px",
    borderRadius: "0px",
    spacingUnit: "4px",
  },
  rules: {
    ".Input": {
      border: "0",
      borderBottom: "3px solid #0b0b0b",
      boxShadow: "none",
      padding: "14px 12px",
    },
    ".Input:focus": { outline: "3px solid #0b0b0b", outlineOffset: "2px", boxShadow: "none" },
    ".Label": {
      fontWeight: "800",
      textTransform: "uppercase",
      letterSpacing: "0.06em",
      fontSize: "13px",
    },
    ".Tab": { border: "2px solid #0b0b0b", boxShadow: "none" },
    ".Tab--selected": { backgroundColor: "#0b0b0b", color: "#fde9d6" },
    ".Error": { fontWeight: "700" },
  },
};

const FONTS = [
  { cssSrc: "https://fonts.googleapis.com/css2?family=Archivo:wght@400;700;800&display=swap" },
];

interface PayStepProps {
  hold: HoldData;
  details: DetailsForm;
  /** Where Stripe returns to after a redirect-based method (3-D Secure, bank apps). */
  returnUrl: string;
  /** Called when payment succeeded without a redirect. */
  onPaid: () => void;
  /** True once the hold has run out; disables paying. */
  expired: boolean;
}

export function PayStep({ hold, details, returnUrl, onPaid, expired }: PayStepProps) {
  const stripe = getStripe();
  const clientSecret = hold.payment?.clientSecret;
  const options = useMemo(
    () => (clientSecret ? { clientSecret, appearance: APPEARANCE, fonts: FONTS } : null),
    [clientSecret],
  );

  if (!stripe || !options || !hold.payment) {
    return (
      <div className="rk-error-panel" role="alert">
        <p>
          Online payment isn&apos;t available right now. Please try again shortly, or contact the
          salon to book.
        </p>
      </div>
    );
  }

  return (
    <div className="rk-pay">
      <div className="rk-pay__amount">
        <span className="rk-eyebrow">Deposit due now</span>
        <strong>{formatAud(hold.payment.amountCents)}</strong>
      </div>
      <Elements stripe={stripe} options={options}>
        <PaymentForm
          amountCents={hold.payment.amountCents}
          details={details}
          returnUrl={returnUrl}
          onPaid={onPaid}
          expired={expired}
        />
      </Elements>
      <p className="rk-pay__fine">
        Payments are processed securely by Stripe. We never see or store your card number. Your
        deposit comes off the price of your service.
      </p>
    </div>
  );
}

interface PaymentFormProps {
  amountCents: number;
  details: DetailsForm;
  returnUrl: string;
  onPaid: () => void;
  expired: boolean;
}

function PaymentForm({ amountCents, details, returnUrl, onPaid, expired }: PaymentFormProps) {
  const stripe = useStripe();
  const elements = useElements();
  const [ready, setReady] = useState(false);
  const [paying, setPaying] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!stripe || !elements || paying || expired) return;
    setPaying(true);
    setError(null);

    const { error: stripeError } = await stripe.confirmPayment({
      elements,
      confirmParams: {
        return_url: returnUrl,
        payment_method_data: {
          billing_details: {
            name: `${details.firstName} ${details.lastName}`.trim(),
            email: details.email.trim(),
            phone: details.phone.trim(),
          },
        },
      },
      redirect: "if_required",
    });

    if (stripeError) {
      const showable = stripeError.type === "card_error" || stripeError.type === "validation_error";
      setError(
        showable && stripeError.message
          ? stripeError.message
          : "We couldn't take that payment. Please check your details or try another method.",
      );
      setPaying(false);
      return;
    }
    onPaid();
  };

  return (
    <form onSubmit={submit} aria-busy={paying}>
      {!ready ? <div className="rk-pay__skeleton" aria-hidden="true" /> : null}
      <PaymentElement
        onReady={() => setReady(true)}
        options={{
          layout: "tabs",
          fields: { billingDetails: { name: "never", email: "never", phone: "never" } },
        }}
      />
      {error ? (
        <p className="rk-pay__error" role="alert">
          {error}
        </p>
      ) : null}
      <button
        type="submit"
        className="rk-btn"
        disabled={!stripe || !elements || !ready || paying || expired}
      >
        {paying ? "Processing…" : `Pay ${formatAud(amountCents)} deposit`}
        {paying ? null : <ArrowRight />}
      </button>
    </form>
  );
}
