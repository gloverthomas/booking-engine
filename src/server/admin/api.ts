import { createLogger } from "@/lib/logger";
import type { Permission } from "../auth/permissions";
import { AdminError } from "./errors";
import { getReadContext, type ReadContext } from "./session";

const log = createLogger("admin");

const HEADERS = { "Cache-Control": "private, no-store" } as const;

function jsonError(message: string, status: number): Response {
  return Response.json({ error: message }, { status, headers: HEADERS });
}

function isRedirect(error: unknown): boolean {
  const digest = (error as { digest?: unknown } | null)?.digest;
  return typeof digest === "string" && digest.startsWith("NEXT_REDIRECT");
}

/**
 * Sign-in and permission check for the JSON read endpoints. Signed out is 401 (the browser code shows
 * "signed out"), a role without the permission is 403, and anything else is logged and returned as 500.
 */
export async function withReadContext(
  permissions: readonly [Permission, ...Permission[]],
  handler: (ctx: ReadContext) => Promise<Response>,
): Promise<Response> {
  let ctx: ReadContext;
  try {
    ctx = await getReadContext(...permissions);
  } catch (error) {
    if (isRedirect(error)) return jsonError("Not signed in", 401);
    if (error instanceof Error && error.name === "AccessDeniedError") {
      return jsonError("You do not have permission to see that", 403);
    }
    if (error instanceof AdminError) return jsonError(error.message, 403);
    log({
      level: "error",
      msg: "read endpoint failed to resolve access",
      error: error instanceof Error ? error.message : String(error),
    });
    return jsonError("Something went wrong", 500);
  }
  try {
    return await handler(ctx);
  } catch (error) {
    if (error instanceof AdminError) return jsonError(error.message, 403);
    throw error;
  }
}

export function jsonOk(body: unknown): Response {
  return Response.json(body, { headers: HEADERS });
}

export function jsonNotFound(message: string): Response {
  return jsonError(message, 404);
}

export function jsonBadRequest(message: string): Response {
  return jsonError(message, 400);
}
