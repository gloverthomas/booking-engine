import { xeroDisconnect } from "@/server/integrations/xero/routes";
import { xeroRouteDeps } from "../../_deps";

export async function POST(request: Request): Promise<Response> {
  return xeroDisconnect(request, xeroRouteDeps());
}
