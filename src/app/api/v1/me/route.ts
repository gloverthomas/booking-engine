import { sessionApi } from "@/server/api/handler";
import { buildMe } from "@/server/api/session";

/** GET /api/v1/me : who is signed in, their role and what they may do. */
export async function GET() {
  return sessionApi(buildMe);
}
