import type { NextRequest } from "next/server";
import { jsonBadRequest, jsonOk, withReadContext } from "@/server/admin/api";
import { searchClients } from "@/server/admin/clients";
import { clientSearchQuerySchema, queryToObject } from "@/server/admin/schemas";

/** GET /clients/search?q= : client picker results for the booking form. */
export async function GET(request: NextRequest) {
  const query = queryToObject(request.nextUrl.searchParams);
  return withReadContext(["clients.view"], async ({ db, access }) => {
    const parsed = clientSearchQuerySchema.safeParse(query);
    if (!parsed.success) return jsonBadRequest("Invalid search");
    const clients = await searchClients(db, access, { q: parsed.data.q, limit: 12 });
    return jsonOk({ clients });
  });
}
