import { handleJoin } from "@/server/waitlist/api";
import { getWaitlistApiDeps } from "./_deps";

export function POST(request: Request): Promise<Response> {
  return handleJoin(getWaitlistApiDeps(), request);
}
