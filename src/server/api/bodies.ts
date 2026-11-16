import { z } from "zod";
import { customHoursSchema, dayOffSchema } from "../roster/schemas";

/** Request bodies shared by a route and the OpenAPI document, so the two cannot disagree. */

export const deviceBody = z.object({ token: z.string().trim().min(10).max(300) });

export const rosterExceptionBody = z.discriminatedUnion("kind", [
  dayOffSchema.extend({ kind: z.literal("off") }),
  customHoursSchema.extend({ kind: z.literal("custom") }),
]);
