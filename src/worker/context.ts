import type { PgBoss } from "pg-boss";
import type { Db } from "@/server/db-types";
import type { LogFn } from "@/lib/logger";

export interface WorkerContext {
  boss: PgBoss;
  db: Db;
  log: LogFn;
  now: () => Date;
}

/** Each handler module exports `register`. src/worker/index.ts calls them all. */
export type RegisterHandlers = (ctx: WorkerContext) => Promise<void>;
