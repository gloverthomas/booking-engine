import type { ReassignInput } from "../contracts";
import type { Db } from "../db-types";

/**
 * OWNER: workstream W3. Move a confirmed, future booking to another stylist at the same time: the new
 * stylist must be rostered, free and offer every service. Re-prices via priceFor for the new stylist's
 * level (the deposit already paid stays as is), emits booking.rescheduled, writes an audit row.
 */
export async function reassignBooking(_db: Db, _input: ReassignInput): Promise<void> {
  throw new Error("reassignBooking not implemented");
}
