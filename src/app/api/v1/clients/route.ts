import { searchClients } from "@/server/admin/clients";
import { clientSearchQuerySchema } from "@/server/admin/schemas";
import { parseQuery, readApi } from "@/server/api/handler";

/** GET /api/v1/clients?q= : client picker, best match first (at most 25). */
export async function GET(request: Request) {
  return readApi(["clients.view"], request, async ({ db, access }) => {
    const { q } = parseQuery(request, clientSearchQuerySchema);
    return { clients: await searchClients(db, access, { q, limit: 25 }) };
  });
}
