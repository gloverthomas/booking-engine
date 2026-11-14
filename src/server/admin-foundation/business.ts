import { asc } from "drizzle-orm";
import { business } from "@/db/schema";
import type { Db } from "@/server/db-types";
import { AdminError } from "./errors";

export interface BusinessRow {
  id: string;
  name: string;
  timezone: string;
  settings: Record<string, unknown>;
}

/** Single-tenant: the one business row. */
export async function getBusiness(db: Db): Promise<BusinessRow> {
  const [row] = await db
    .select({
      id: business.id,
      name: business.name,
      timezone: business.timezone,
      settings: business.settings,
    })
    .from(business)
    .orderBy(asc(business.createdAt))
    .limit(1);
  if (!row) {
    throw new AdminError("no_business", "No business exists yet. Run `pnpm db:seed` first.");
  }
  return row;
}
