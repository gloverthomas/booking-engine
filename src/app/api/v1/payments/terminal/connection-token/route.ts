import { commandApi } from "@/server/api/handler";
import { createConnectionToken } from "@/server/payments";

/** POST /api/v1/payments/terminal/connection-token : a short-lived secret for the Stripe Terminal SDK. */
export async function POST(request: Request) {
  return commandApi(["checkout"], request, () => createConnectionToken());
}
