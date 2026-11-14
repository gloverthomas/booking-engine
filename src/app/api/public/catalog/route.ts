import { connection } from "next/server";
import { getPublicApiDeps } from "@/lib/public-api-deps";
import { handleCatalog } from "@/lib/public-api-handlers";

export async function GET(request: Request): Promise<Response> {
  // Always request-time: reads headers, the database and the clock.
  await connection();
  return handleCatalog(getPublicApiDeps(), request);
}
