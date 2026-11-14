import { connection } from "next/server";
import { googleConnect } from "@/server/integrations/google/routes";
import { googleRouteDeps } from "../../_deps";

export async function GET(request: Request): Promise<Response> {
  await connection(); // never prerender: this reads cookies and talks to the provider
  return googleConnect(request, googleRouteDeps());
}
