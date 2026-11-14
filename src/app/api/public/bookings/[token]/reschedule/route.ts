import { getPublicApiDeps } from "@/lib/public-api-deps";
import { handleRescheduleBooking } from "@/lib/public-api-handlers-booking";

export async function POST(
  request: Request,
  ctx: RouteContext<"/api/public/bookings/[token]/reschedule">,
): Promise<Response> {
  const { token } = await ctx.params;
  return handleRescheduleBooking(getPublicApiDeps(), request, token);
}
