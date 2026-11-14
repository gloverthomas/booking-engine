import { connection } from "next/server";
import { xeroListAccounts } from "@/server/integrations/xero/routes";
import { xeroRouteDeps } from "../../_deps";

export async function GET(request: Request): Promise<Response> {
  await connection(); // never prerender: this reads cookies and talks to the provider
  return xeroListAccounts(request, xeroRouteDeps());
}
