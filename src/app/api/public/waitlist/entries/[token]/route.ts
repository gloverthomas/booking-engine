import { handleGetEntry } from "@/server/waitlist/api";
import { getWaitlistApiDeps } from "../../_deps";

export async function GET(
  request: Request,
  ctx: RouteContext<"/api/public/waitlist/entries/[token]">,
): Promise<Response> {
  const { token } = await ctx.params;
  return handleGetEntry(getWaitlistApiDeps(), request, token);
}
