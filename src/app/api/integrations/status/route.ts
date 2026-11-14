import { connection } from "next/server";
import { getDb } from "@/db/client";
import { requireOwner } from "@/server/auth";
import { jsonResponse } from "@/server/integrations/common/http";
import { getIntegrationStatuses } from "@/server/integrations/common/status";

/** Connection state for the admin Integrations section ("reconnect" when needsReconnect). */
export async function GET(_request: Request): Promise<Response> {
  await connection(); // never prerender: owner-only, per-request data
  await requireOwner();
  return jsonResponse({ integrations: await getIntegrationStatuses(getDb()) });
}
