import { getDb } from "@/db/client";
import { checkHealth } from "@/lib/health";

export async function GET(): Promise<Response> {
  const result = await checkHealth(getDb());
  return Response.json(result, { status: result.ok ? 200 : 503 });
}
