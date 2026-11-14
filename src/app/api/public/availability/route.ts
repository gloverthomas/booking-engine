import { connection } from "next/server";
import { getPublicApiDeps } from "@/lib/public-api-deps";
import { handleAvailability } from "@/lib/public-api-handlers";

export async function GET(request: Request): Promise<Response> {
  await connection();
  return handleAvailability(getPublicApiDeps(), request);
}
