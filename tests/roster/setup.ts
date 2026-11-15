import { location } from "@/db/schema";
import type { Db } from "@/server/db-types";
import { createStaff } from "../helpers/factories";
import { createWorld, openEveryDay, type World } from "../availability/setup";

export { createWorld, type World };

/** "Today" for roster commands: Sunday 2026-11-01 10:00 UTC (Melbourne evening). */
export const TODAY = new Date("2026-11-01T00:00:00Z");

export async function addLocation(db: Db, businessId: string, name: string) {
  const [row] = await db.insert(location).values({ businessId, name }).returning();
  return row;
}

export async function addStylist(db: Db, w: World, name: string, level = 0) {
  const row = await createStaff(db, w.businessId, {
    name,
    level,
    email: `${name.toLowerCase()}@example.com`,
  });
  await openEveryDay(db, row.id, w.locationId);
  return row;
}
