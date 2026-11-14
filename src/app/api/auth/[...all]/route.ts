import { toNextJsHandler } from "better-auth/next-js";
import { getAuth } from "@/server/auth";

/** Better Auth endpoints (Google OAuth start/callback, session, sign-out). Created lazily so importing never needs env. */
function handlers() {
  return toNextJsHandler(getAuth());
}

export function GET(request: Request): Promise<Response> {
  return handlers().GET(request);
}

export function POST(request: Request): Promise<Response> {
  return handlers().POST(request);
}
