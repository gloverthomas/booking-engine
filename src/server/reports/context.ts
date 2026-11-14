import { asc } from "drizzle-orm";
import { business } from "@/db/schema";
import type { Db } from "../db-types";

export interface BusinessContext {
  businessId: string;
  name: string;
  timezone: string;
}

/** The single business row (the app is single-tenant). Throws a readable error if setup has not run. */
export async function loadBusinessContext(db: Db): Promise<BusinessContext> {
  const [row] = await db.select().from(business).orderBy(asc(business.createdAt)).limit(1);
  if (!row) throw new Error("No business is set up yet. Run the seed or create the business row.");
  return { businessId: row.id, name: row.name, timezone: row.timezone };
}
