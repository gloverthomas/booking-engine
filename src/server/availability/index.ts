import type { AvailabilityQuery, AvailableSlot } from "../contracts";
import type { Db } from "../db-types";

/** OWNER: workstream A (domain core). Replace this stub; keep the signature. */
export async function getAvailableSlots(
  _db: Db,
  _query: AvailabilityQuery,
): Promise<AvailableSlot[]> {
  throw new Error("getAvailableSlots not implemented");
}
