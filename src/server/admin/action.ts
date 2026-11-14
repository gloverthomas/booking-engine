import { ZodError } from "zod";
import { createLogger } from "@/lib/logger";
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

/** Wrap a server action body: turn thrown errors into `{ ok: false, error }` and log the unexpected ones. */
export async function runAction<T>(name: string, body: () => Promise<T>): Promise<ActionResult<T>> {
  try {
    return { ok: true, data: await body() };
  } catch (error) {
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
