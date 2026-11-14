import { googleWebhook } from "@/server/integrations/google/routes";
import { googleRouteDeps } from "../../_deps";

/** Google push notifications. Authenticated by the channel token, not by a session. */
export async function POST(request: Request): Promise<Response> {
  return googleWebhook(request, googleRouteDeps());
}
