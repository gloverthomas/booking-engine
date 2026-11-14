import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { getEnv } from "@/lib/env";
import * as schema from "./schema";

let pool: Pool | undefined;

/** Shared connection pool + typed Drizzle client for the web app and worker. */
export function getDb() {
  pool ??= new Pool({ connectionString: getEnv().DATABASE_URL, max: 10 });
  return drizzle(pool, { schema });
}

export async function closeDb(): Promise<void> {
  await pool?.end();
  pool = undefined;
}
