import { readApi } from "@/server/api/handler";
import { terminalLocationId } from "@/server/payments";

/** GET /api/v1/payments/terminal : whether Tap to Pay is set up, and the Stripe Location to connect to. */
export async function GET(request: Request) {
  return readApi(["checkout"], request, async () => {
    const locationId = terminalLocationId();
    return { configured: locationId !== null, locationId };
  });
}
