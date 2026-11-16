import type { Actor } from "../audit";
import { ApiError } from "./respond";

export type StaffActor = Extract<Actor, `owner:${string}` | `staff:${string}`>;

/** Commands that record "who offered this" want a signed-in person, not the system or an integration. */
export function staffActor(actor: Actor): StaffActor {
  if (actor.startsWith("owner:") || actor.startsWith("staff:")) return actor as StaffActor;
  throw new ApiError(403, "forbidden", "You do not have permission to do that");
}
