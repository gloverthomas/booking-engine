import { sql } from "drizzle-orm";
import type { Db } from "@/server/db-types";

/**
 * Serialises everything that creates or re-emails a staff row (the staff commands and owner
 * provisioning at sign-in), so "emails are unique among active staff" cannot be raced past.
 * Transaction-scoped: released automatically on commit or rollback.
 */
export async function lockStaffWrites(tx: Db): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext('staff-writes'))`);
}
