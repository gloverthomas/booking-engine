import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import type * as schema from "@/db/schema";

/** Works for both the node-postgres client (prod) and PGlite (tests), and for transactions. */
export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;
