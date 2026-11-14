import { sql, type SQL } from "drizzle-orm";

export interface Queryable {
  execute(query: SQL): Promise<unknown>;
}

export interface HealthResult {
  ok: boolean;
  checks: { database: "up" | "down" };
}

/** Liveness + dependency check. Never includes error details in the result. */
export async function checkHealth(db: Queryable): Promise<HealthResult> {
  try {
    await db.execute(sql`select 1`);
    return { ok: true, checks: { database: "up" } };
  } catch {
    return { ok: false, checks: { database: "down" } };
  }
}
