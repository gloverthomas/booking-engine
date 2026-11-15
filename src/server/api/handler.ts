import { connection } from "next/server";
import type { z } from "zod";
import { queryToObject } from "../admin/schemas";
import { getCommandContext, getReadContext, type ReadContext } from "../admin/session";
import type { CommandContext } from "../admin/commands";
import type { AccessSession } from "../auth/access-core";
import { requireAccessSession } from "../auth";
import type { Permission } from "../auth/permissions";
import { ApiError, errorResponse, ok } from "./respond";

/** One or more permissions where any is enough (a stylist has calendar.viewOwn, reception calendar.viewAll). */
export type AnyOf = readonly [Permission, ...Permission[]];

const MAX_BODY_BYTES = 256 * 1024;

export async function parseBody<S extends z.ZodType>(
  request: Request,
  schema: S,
): Promise<z.output<S>> {
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES)
    throw new ApiError(413, "too_large", "That request is too large");
  let raw: unknown;
  try {
    raw = text === "" ? {} : JSON.parse(text);
  } catch {
    throw new ApiError(400, "invalid_json", "The request body is not valid JSON");
  }
  return schema.parse(raw);
}

export function parseQuery<S extends z.ZodType>(request: Request, schema: S): z.output<S> {
  return schema.parse(queryToObject(new URL(request.url).searchParams));
}

/** A read-only endpoint. Return null from `run` for a 404. */
export async function readApi<T>(
  permissions: AnyOf,
  request: Request,
  run: (ctx: ReadContext, request: Request) => Promise<T | null>,
): Promise<Response> {
  try {
    await connection(); // request-time only: this reads the caller's token
    const ctx = await getReadContext(...permissions);
    const data = await run(ctx, request);
    if (data === null) throw new ApiError(404, "not_found", "That was not found");
    return ok(data);
  } catch (error) {
    return errorResponse(error);
  }
}

/** A mutating endpoint. The command itself re-checks the permission and, for stylists, ownership. */
export async function commandApi<T>(
  permissions: AnyOf,
  request: Request,
  run: (ctx: CommandContext, request: Request) => Promise<T>,
  successStatus = 200,
): Promise<Response> {
  try {
    await connection();
    const ctx = await getCommandContext(...permissions);
    return ok(await run(ctx, request), successStatus);
  } catch (error) {
    return errorResponse(error);
  }
}

/** For endpoints that only need to know who is calling (`/me`). */
export async function sessionApi<T>(
  run: (session: AccessSession) => Promise<T>,
): Promise<Response> {
  try {
    await connection();
    return ok(await run(await requireAccessSession()));
  } catch (error) {
    return errorResponse(error);
  }
}
