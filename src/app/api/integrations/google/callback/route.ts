import { connection } from "next/server";
import { googleCallback } from "@/server/integrations/google/routes";
import { googleRouteDeps } from "../../_deps";

export async function GET(request: Request): Promise<Response> {
  await connection(); // never prerender: this reads cookies and talks to the provider
  return googleCallback(request, googleRouteDeps());
}
