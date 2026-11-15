import { unstable_rethrow } from "next/navigation";
import { ZodError } from "zod";
import { createLogger } from "@/lib/logger";
import { BOOKING_NOT_FOUND_MESSAGE, NOT_ALLOWED_MESSAGE } from "../admin/access";
import { AdminError, isOverlapError } from "../admin/errors";
import { AccessDeniedError } from "../auth/access-core";
import {
  BookingStateError,
  ClientBlockedError,
  NotFoundError,
  NotRosteredError,
  PolicyVersionError,
  SlotTakenError,
  ValidationError,
  VipOnlyError,
} from "../booking/errors";

/**
 * The mobile contract: success is `{ data }`, failure is `{ error: { code, message, fields? } }` with a
 * real HTTP status. `code` is stable and meant for the app to branch on; `message` is safe to show.
 */
export interface ApiErrorBody {
  code: string;
  message: string;
  fields?: Record<string, string>;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly fields?: Record<string, string>,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

const log = createLogger("api");
const HEADERS = { "Cache-Control": "private, no-store" } as const;

export function ok<T>(data: T, status = 200): Response {
  return Response.json({ data }, { status, headers: HEADERS });
}

export function failure(status: number, body: ApiErrorBody): Response {
  return Response.json({ error: body }, { status, headers: HEADERS });
}

function isNextRedirect(error: unknown): boolean {
  const digest = (error as { digest?: unknown } | null)?.digest;
  return typeof digest === "string" && digest.startsWith("NEXT_REDIRECT");
}

function fieldsOf(error: ZodError): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = issue.path.join(".") || "body";
    if (!(key in fields)) fields[key] = issue.message;
  }
  return fields;
}

/** Every thrown thing becomes a response. Only unknown errors are logged, and their text is never returned. */
export function errorResponse(error: unknown): Response {
  if (error instanceof ApiError) {
    return failure(error.status, {
      code: error.code,
      message: error.message,
      ...(error.fields ? { fields: error.fields } : {}),
    });
  }
  // requireAccess() redirects to /login when nobody is signed in; for an API that is a 401.
  if (isNextRedirect(error)) {
    return failure(401, { code: "unauthenticated", message: "Sign in to continue" });
  }
  if (error instanceof AccessDeniedError) {
    return failure(403, { code: "forbidden", message: "You do not have permission to do that" });
  }
  if (error instanceof ZodError) {
    return failure(422, {
      code: "invalid_request",
      message: "Please check the highlighted fields",
      fields: fieldsOf(error),
    });
  }
  if (error instanceof NotFoundError) {
    return failure(404, { code: "not_found", message: error.message });
  }
  if (error instanceof SlotTakenError || isOverlapError(error)) {
    return failure(409, { code: "slot_taken", message: "That time is no longer available" });
  }
  if (error instanceof NotRosteredError) {
    return failure(409, { code: "not_rostered", message: error.message });
  }
  if (error instanceof BookingStateError) {
    return failure(409, { code: "invalid_state", message: error.message });
  }
  if (error instanceof PolicyVersionError) {
    return failure(409, { code: "policy_changed", message: error.message });
  }
  if (error instanceof ClientBlockedError || error instanceof VipOnlyError) {
    return failure(403, { code: "not_allowed", message: error.message });
  }
  if (error instanceof ValidationError) {
    return failure(422, { code: "invalid_request", message: error.message });
  }
  if (error instanceof AdminError) {
    // The commands signal these two outcomes by message; the API gives them their proper statuses.
    if (error.message === BOOKING_NOT_FOUND_MESSAGE) {
      return failure(404, { code: "not_found", message: error.message });
    }
    if (error.message === NOT_ALLOWED_MESSAGE) {
      return failure(403, { code: "forbidden", message: "You do not have permission to do that" });
    }
    return failure(400, { code: "rejected", message: error.message });
  }
  // Next's own control flow (a prerender bailout, notFound) must never be turned into a 500.
  unstable_rethrow(error);
  log({
    level: "error",
    msg: "api request failed",
    error: error instanceof Error ? error.message : "unknown",
  });
  return failure(500, { code: "internal", message: "Something went wrong. Please try again." });
}
