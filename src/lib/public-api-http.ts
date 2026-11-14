import type { ZodType, z } from "zod";
import type { ApiEnvelope, ApiErrorBody } from "./public-api-types";
import { fieldErrorsFrom } from "./public-api-schemas";

const NO_STORE = { "Cache-Control": "no-store" } as const;

/** Thrown inside handlers; `guard` turns it into the standard error envelope. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly fieldErrors?: Record<string, string>,
    readonly headers?: Record<string, string>,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export function ok<T>(data: T, init: { status?: number; headers?: Record<string, string> } = {}) {
  const body: ApiEnvelope<T> = { success: true, data };
  return Response.json(body, {
    status: init.status ?? 200,
    headers: { ...NO_STORE, ...init.headers },
  });
}

export function fail(
  status: number,
  error: ApiErrorBody,
  headers: Record<string, string> = {},
): Response {
  const body: ApiEnvelope<never> = { success: false, error };
  return Response.json(body, { status, headers: { ...NO_STORE, ...headers } });
}

export interface RequestLog {
  (entry: Record<string, unknown>): void;
}

/**
 * Run a handler and convert every failure into the envelope. Unexpected errors are logged in
 * full but only ever surface as a generic message, so internals never reach the client.
 */
export async function guard(
  run: () => Promise<Response>,
  log: RequestLog,
  route: string,
): Promise<Response> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof ApiError) {
      return fail(
        error.status,
        { code: error.code, message: error.message, fieldErrors: error.fieldErrors },
        error.headers,
      );
    }
    log({
      level: "error",
      event: "public_api_unexpected",
      route,
      error: error instanceof Error ? { name: error.name, message: error.message } : String(error),
    });
    return fail(500, {
      code: "internal_error",
      message: "Something went wrong on our side. Please try again in a moment.",
    });
  }
}

const MAX_BODY_BYTES = 32_768;

/** Read and parse a JSON body with a size cap. */
export async function readJson(request: Request): Promise<unknown> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > MAX_BODY_BYTES) {
    throw new ApiError(413, "payload_too_large", "That request is too large.");
  }
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) {
    throw new ApiError(413, "payload_too_large", "That request is too large.");
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new ApiError(400, "invalid_json", "We couldn't read that request.");
  }
}

/** Validate with zod, converting failures to a 422 with per-field messages. */
export function parseOrThrow<S extends ZodType>(schema: S, input: unknown): z.output<S> {
  const result = schema.safeParse(input);
  if (!result.success) {
    const fieldErrors = fieldErrorsFrom(result.error);
    const first = Object.values(fieldErrors)[0] ?? "Please check your details.";
    throw new ApiError(422, "validation_failed", first, fieldErrors);
  }
  return result.data;
}

/**
 * Best-effort client address for rate limiting. `hops` is how many trusted proxies sit in front
 * of the app (each appends to X-Forwarded-For); we read that many entries from the right so a
 * client-supplied leading entry cannot dodge the limiter.
 */
export function clientIp(request: Request, hops = 1): string {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) {
    const parts = forwarded
      .split(",")
      .map((p) => p.trim())
      .filter(Boolean);
    if (parts.length > 0) return parts[Math.max(0, parts.length - hops)];
  }
  return request.headers.get("x-real-ip")?.trim() || "unknown";
}
