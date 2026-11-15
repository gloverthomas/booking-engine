import { unstable_rethrow } from "next/navigation";
import { ZodError } from "zod";
import { createLogger } from "@/lib/logger";
import { NOT_ALLOWED_MESSAGE } from "./access";
import { AdminError, isOverlapError, type ActionResult } from "./errors";

const log = createLogger("admin");

const GENERIC = "Something went wrong. Please try again.";
const MAX_DOMAIN_MESSAGE = 200;

function looksLikeDatabaseError(error: Error): boolean {
  const withCode = error as Error & { code?: unknown; cause?: unknown };
  if (typeof withCode.code === "string") return true;
  if (withCode.cause instanceof Error && looksLikeDatabaseError(withCode.cause)) return true;
  return /^Failed query/i.test(error.message);
}

/** What the owner sees. Domain errors pass through; database and unknown errors never leak details. */
export function userFacingMessage(error: unknown): string {
  if (error instanceof AdminError) return error.message;
  // Thrown by requireAccess; matched by name so this file never imports the auth module.
  if (error instanceof Error && error.name === "AccessDeniedError") return NOT_ALLOWED_MESSAGE;
  if (error instanceof ZodError) {
    return error.issues[0]?.message ?? "Please check the details and try again.";
  }
  if (isOverlapError(error)) return "That time overlaps another booking or blocked time.";
  if (error instanceof Error && !looksLikeDatabaseError(error)) {
    const message = error.message.trim();
    if (message && message.length <= MAX_DOMAIN_MESSAGE) return message;
  }
  return GENERIC;
}

/**
 * Wrap a server action body: turn thrown errors into `{ ok: false, error }` and log the unexpected ones.
 * Call `getCommandContext(...)` inside the body so the access check is covered too; Next's own control-flow
 * errors (the redirect to /login for a signed-out user) are rethrown, never swallowed.
 */
export async function runAction<T>(name: string, body: () => Promise<T>): Promise<ActionResult<T>> {
  try {
    return { ok: true, data: await body() };
  } catch (error) {
    unstable_rethrow(error);
    if (!(error instanceof AdminError) && !(error instanceof ZodError)) {
      log({
        level: "error",
        msg: "admin action failed",
        action: name,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return { ok: false, error: userFacingMessage(error) };
  }
}
