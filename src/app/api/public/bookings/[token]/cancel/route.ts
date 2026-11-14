import { getPublicApiDeps } from "@/lib/public-api-deps";
import { handleCancelBooking } from "@/lib/public-api-handlers-booking";

export async function POST(
  request: Request,
  ctx: RouteContext<"/api/public/bookings/[token]/cancel">,
): Promise<Response> {
  const { token } = await ctx.params;
  return handleCancelBooking(getPublicApiDeps(), request, token);
}
