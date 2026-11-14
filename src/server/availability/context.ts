import { eq } from "drizzle-orm";
import { business, location } from "@/db/schema";
import { NotFoundError } from "../booking/errors";
import type { Db } from "../db-types";
import { parseSettings, type BusinessSettings } from "../settings";

export interface BusinessContext {
  businessId: string;
  timezone: string;
  settings: BusinessSettings;
  locationActive: boolean;
}

/** Resolve the business (timezone + settings) that owns a location. */
export async function getBusinessContext(db: Db, locationId: string): Promise<BusinessContext> {
  const [loc] = await db.select().from(location).where(eq(location.id, locationId));
  if (!loc) throw new NotFoundError(`Location not found: ${locationId}`);

  let biz: typeof business.$inferSelect | undefined;
  if (loc.businessId) {
    [biz] = await db.select().from(business).where(eq(business.id, loc.businessId));
  } else {
    [biz] = await db.select().from(business).limit(1);
  }
  if (!biz) throw new NotFoundError(`Business not found for location ${locationId}`);

  return {
    businessId: biz.id,
    timezone: biz.timezone,
    settings: parseSettings(biz.settings),
    locationActive: loc.active,
  };
}
