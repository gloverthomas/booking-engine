import Stripe from "stripe";
import { getEnv } from "@/lib/env";

export const CURRENCY = "aud";

export type PaymentErrorCode =
  | "stripe_not_configured"
  | "booking_not_found"
  | "payment_not_found"
  | "booking_not_payable"
  | "hold_expired"
  | "no_deposit_due"
  | "invalid_amount"
  | "not_refundable"
  | "stripe_error";

/** A typed failure the caller (route, worker, admin action) can branch on via `code`. */
export class PaymentError extends Error {
  constructor(
    readonly code: PaymentErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "PaymentError";
  }
}

export interface StripeIntentLike {
  id: string;
  status: string;
  amount: number;
  client_secret: string | null;
}

export interface StripeRefundLike {
  id: string;
  status: string | null;
}

export interface StripeEventLike {
  id: string;
  type: string;
  /** Unix seconds, as Stripe sends it. */
  created?: number;
  data: { object: unknown };
}

export interface StripeRequestOptions {
  idempotencyKey: string;
}

/** The narrow slice of the Stripe SDK we use. Tests inject a fake; production gets the real client. */
export interface StripeLike {
  customers: {
    create(
      params: { name?: string; email?: string; phone?: string; metadata: Record<string, string> },
      options: StripeRequestOptions,
    ): Promise<{ id: string }>;
  };
  paymentIntents: {
    create(
      params: {
        amount: number;
        currency: string;
        customer: string;
        description?: string;
        metadata: Record<string, string>;
        automatic_payment_methods?: { enabled: boolean };
        setup_future_usage?: "off_session";
        payment_method?: string;
        off_session?: boolean;
        confirm?: boolean;
      },
      options: StripeRequestOptions,
    ): Promise<StripeIntentLike>;
    retrieve(id: string): Promise<StripeIntentLike>;
  };
  refunds: {
    create(
      params: { payment_intent: string; amount: number; metadata: Record<string, string> },
      options: StripeRequestOptions,
    ): Promise<StripeRefundLike>;
  };
  webhooks: {
    constructEvent(payload: string, header: string, secret: string): StripeEventLike;
  };
}

export interface PaymentDeps {
  stripe?: StripeLike;
  now?: Date;
}

let cachedClient: StripeLike | undefined;

/** Injected client, or a real one built lazily from STRIPE_SECRET_KEY. Fails only when actually used. */
export function getStripe(deps?: PaymentDeps): StripeLike {
  if (deps?.stripe) return deps.stripe;
  if (cachedClient) return cachedClient;
  const key = getEnv().STRIPE_SECRET_KEY;
  if (!key) {
    throw new PaymentError(
      "stripe_not_configured",
      "STRIPE_SECRET_KEY is not set. Add your Stripe secret key to the environment to take payments.",
    );
  }
  cachedClient = new Stripe(key);
  return cachedClient;
}

export function getWebhookSecret(): string {
  const secret = getEnv().STRIPE_WEBHOOK_SECRET;
  if (!secret) {
    throw new PaymentError(
      "stripe_not_configured",
      "STRIPE_WEBHOOK_SECRET is not set. Add the signing secret of your Stripe webhook endpoint.",
    );
  }
  return secret;
}

export function nowOf(deps?: PaymentDeps): Date {
  return deps?.now ?? new Date();
}
