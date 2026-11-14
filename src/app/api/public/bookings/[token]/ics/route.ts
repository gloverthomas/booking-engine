import { getPublicApiDeps } from "@/lib/public-api-deps";
import { handleBookingIcs } from "@/lib/public-api-handlers-booking";

export async function GET(
  request: Request,
  ctx: RouteContext<"/api/public/bookings/[token]/ics">,
): Promise<Response> {
  const { token } = await ctx.params;
  return handleBookingIcs(getPublicApiDeps(), request, token);
}
