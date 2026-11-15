import { z } from "zod";
import { ApiError } from "./respond";

const idSchema = z.uuid();

/** `[id]` route segment, validated so a malformed id is a clean 404 instead of a database error. */
export async function idParam(context: { params: Promise<{ id: string }> }): Promise<string> {
  const { id } = await context.params;
  const parsed = idSchema.safeParse(id);
  if (!parsed.success) throw new ApiError(404, "not_found", "That was not found");
  return parsed.data;
}

export interface IdContext {
  params: Promise<{ id: string }>;
}
