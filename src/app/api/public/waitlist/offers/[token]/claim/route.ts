import { handleClaim } from "@/server/waitlist/api";
import { getWaitlistApiDeps } from "../../../_deps";

export async function POST(
  request: Request,
  ctx: RouteContext<"/api/public/waitlist/offers/[token]/claim">,
): Promise<Response> {
  const { token } = await ctx.params;
  return handleClaim(getWaitlistApiDeps(), request, token);
}
