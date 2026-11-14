import type { NextRequest } from "next/server";
import { getDb } from "@/db/client";
import { getOwnerSession } from "@/server/auth";
import { searchClients } from "@/server/admin/clients";
import { clientSearchQuerySchema, queryToObject } from "@/server/admin/schemas";

/** GET /clients/search?q= : client picker results for the booking form. */
export async function GET(request: NextRequest) {
  const query = queryToObject(request.nextUrl.searchParams);
  if (!(await getOwnerSession())) {
    return Response.json({ error: "Not signed in" }, { status: 401 });
  }
  const parsed = clientSearchQuerySchema.safeParse(query);
  if (!parsed.success) return Response.json({ error: "Invalid search" }, { status: 400 });
  const clients = await searchClients(getDb(), { q: parsed.data.q, limit: 12 });
  return Response.json({ clients }, { headers: { "Cache-Control": "private, no-store" } });
}
