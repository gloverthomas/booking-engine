import { getPublicApiDeps } from "@/lib/public-api-deps";
import { handleGetBooking } from "@/lib/public-api-handlers-booking";

export async function GET(
  request: Request,
  ctx: RouteContext<"/api/public/bookings/[token]">,
): Promise<Response> {
  const { token } = await ctx.params;
  return handleGetBooking(getPublicApiDeps(), request, token);
}
