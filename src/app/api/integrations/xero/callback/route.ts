import { connection } from "next/server";
import { xeroCallback } from "@/server/integrations/xero/routes";
import { xeroRouteDeps } from "../../_deps";

export async function GET(request: Request): Promise<Response> {
  await connection(); // never prerender: this reads cookies and talks to the provider
  return xeroCallback(request, xeroRouteDeps());
}
