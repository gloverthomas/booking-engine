import { getPublicApiDeps } from "@/lib/public-api-deps";
import { handleCatalog } from "@/lib/public-api-handlers";

export function GET(request: Request): Promise<Response> {
  return handleCatalog(getPublicApiDeps(), request);
}
