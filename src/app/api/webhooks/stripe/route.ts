import { getDb } from "@/db/client";
import { handleStripeWebhook } from "@/server/payments/webhook-handler";

/** Stripe webhook endpoint. Signature is verified against the raw body, never a parsed one. */
export async function POST(request: Request): Promise<Response> {
  const payload = await request.text();
  const { status, body } = await handleStripeWebhook(getDb(), {
    payload,
    signature: request.headers.get("stripe-signature"),
  });
  return Response.json(body, { status });
}
