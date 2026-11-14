import { sql } from "drizzle-orm";
import type { Db } from "@/server/db-types";

interface RowsResult {
  rows: Array<Record<string, unknown>>;
}

/**
 * Runs `fn` inside a transaction holding a Postgres advisory lock named `name`.
 *
 * - `wait: true` blocks until the lock is free (used for Xero token refresh: refresh tokens are
 *   single-use, so two refreshes must never race).
 * - `wait: false` returns `{ acquired: false }` immediately when someone else holds it (used to
 *   keep two Google syncs from running at once).
 *
 * The lock is released when the transaction ends. Anything `fn` writes through `tx` commits
 * together with it, which is how a rotated refresh token is persisted before it is used.
 */
export async function withAdvisoryLock<T>(
  db: Db,
  name: string,
  options: { wait: boolean },
  fn: (tx: Db) => Promise<T>,
): Promise<{ acquired: true; value: T } | { acquired: false }> {
  return db.transaction(async (tx) => {
    if (options.wait) {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${name}))`);
    } else {
      const result = (await tx.execute(
        sql`select pg_try_advisory_xact_lock(hashtext(${name})) as locked`,
      )) as unknown as RowsResult;
      if (result.rows[0]?.locked !== true) return { acquired: false } as const;
    }
    return { acquired: true, value: await fn(tx as unknown as Db) } as const;
  });
}
