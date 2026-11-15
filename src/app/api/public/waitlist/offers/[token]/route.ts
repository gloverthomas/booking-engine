import { handleGetOffer } from "@/server/waitlist/api";
import { getWaitlistApiDeps } from "../../_deps";

export async function GET(
  request: Request,
  ctx: RouteContext<"/api/public/waitlist/offers/[token]">,
): Promise<Response> {
  const { token } = await ctx.params;
  return handleGetOffer(getWaitlistApiDeps(), request, token);
}
