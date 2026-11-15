import { getAuth } from "@/server/auth";
import { ok } from "@/server/api/respond";

/** POST /api/v1/auth/signout : ends the session behind the bearer token. Safe to call twice. */
export async function POST(request: Request) {
  try {
    await getAuth().api.signOut({ headers: request.headers });
  } catch {
    // Already signed out, expired or malformed: the goal (no session) is met either way.
  }
  return ok({ signedOut: true });
}
