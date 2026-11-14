import { getPublicApiDeps } from "@/lib/public-api-deps";
import { handleAvailability } from "@/lib/public-api-handlers";

export function GET(request: Request): Promise<Response> {
  return handleAvailability(getPublicApiDeps(), request);
}
