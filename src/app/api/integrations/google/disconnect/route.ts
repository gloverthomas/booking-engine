import { googleDisconnect } from "@/server/integrations/google/routes";
import { googleRouteDeps } from "../../_deps";

export async function POST(request: Request): Promise<Response> {
  return googleDisconnect(request, googleRouteDeps());
}
