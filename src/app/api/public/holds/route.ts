import { getPublicApiDeps } from "@/lib/public-api-deps";
import { handleCreateHold } from "@/lib/public-api-handlers";

export function POST(request: Request): Promise<Response> {
  return handleCreateHold(getPublicApiDeps(), request);
}
