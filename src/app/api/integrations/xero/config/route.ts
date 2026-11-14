import { connection } from "next/server";
import { xeroGetConfig, xeroUpdateConfig } from "@/server/integrations/xero/routes";
import { xeroRouteDeps } from "../../_deps";

export async function GET(request: Request): Promise<Response> {
  await connection(); // never prerender: owner-only, per-request data
  return xeroGetConfig(request, xeroRouteDeps());
}

export async function PATCH(request: Request): Promise<Response> {
  return xeroUpdateConfig(request, xeroRouteDeps());
}
