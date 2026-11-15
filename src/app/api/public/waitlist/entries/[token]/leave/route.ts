import { handleLeave } from "@/server/waitlist/api";
import { getWaitlistApiDeps } from "../../../_deps";

export async function POST(
  request: Request,
  ctx: RouteContext<"/api/public/waitlist/entries/[token]/leave">,
): Promise<Response> {
  const { token } = await ctx.params;
  return handleLeave(getWaitlistApiDeps(), request, token);
}
