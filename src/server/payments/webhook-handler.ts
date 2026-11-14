import { createLogger } from "@/lib/logger";
import type { Db } from "../db-types";
import { processStripeEvent } from "./webhook";
import {
  PaymentError,
  getStripe,
  getWebhookSecret,
  type PaymentDeps,
  type StripeEventLike,
} from "./stripe";

const log = createLogger("stripe-webhook");

export interface WebhookResponse {
  status: number;
  body: { received: boolean; duplicate?: boolean; error?: string };
}

/**
 * HTTP-agnostic core of POST /api/webhooks/stripe. `payload` must be the exact raw request body,
 * otherwise the signature check fails.
 */
export async function handleStripeWebhook(
  db: Db,
  input: { payload: string; signature: string | null },
  deps?: PaymentDeps,
): Promise<WebhookResponse> {
  if (!input.signature) {
    return { status: 400, body: { received: false, error: "Missing Stripe-Signature header" } };
  }

  let event: StripeEventLike;
  try {
    event = getStripe(deps).webhooks.constructEvent(
      input.payload,
      input.signature,
      getWebhookSecret(),
    );
  } catch (error) {
    if (error instanceof PaymentError) {
      log({ event: "webhook_not_configured", message: error.message });
      return { status: 500, body: { received: false, error: "Webhook is not configured" } };
    }
    return { status: 400, body: { received: false, error: "Invalid signature" } };
  }

  try {
    const outcome = await processStripeEvent(db, event, deps);
    return {
      status: 200,
      body: outcome === "duplicate" ? { received: true, duplicate: true } : { received: true },
    };
  } catch (error) {
    log({
      event: "webhook_processing_failed",
      eventId: event.id,
      type: event.type,
      message: error instanceof Error ? error.message : "Unknown error",
    });
    // 5xx makes Stripe retry; nothing was committed.
    return { status: 500, body: { received: false, error: "Processing failed" } };
  }
}
