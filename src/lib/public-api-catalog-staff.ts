import { and, asc, eq, gte, inArray, isNull, or } from "drizzle-orm";
import { availabilityRule, serviceLevelPrice, serviceStaff, staff } from "@/db/schema";
import type { Db } from "@/server/db-types";
import { priceFor } from "@/server/pricing";
import type { CatalogStaff } from "./public-api-types";

/** A service as the public catalog lists it at a location. */
export interface LocationService {
  id: string;
  priceCents: number;
  durationMin: number;
}

/**
 * The stylists a client may choose at each location. A stylist is listed when they are active, work
 * at the location (an unexpired weekly rule there) and offer at least one of its services; their
 * price and time per service come only from priceFor (own override, then level, then the service).
 * `today` is the business-local date, used to ignore weekly rules that have ended.
 */
export async function loadStaffByLocation(
  db: Db,
  locations: ReadonlyMap<string, readonly LocationService[]>,
  today: string,
): Promise<Map<string, CatalogStaff[]>> {
  const result = new Map<string, CatalogStaff[]>();
  const locationIds = [...locations.keys()];
  const serviceIds = [...new Set([...locations.values()].flatMap((l) => l.map((s) => s.id)))];
  if (locationIds.length === 0 || serviceIds.length === 0) return result;

  const [people, offers, levels, rules] = await Promise.all([
    db
      .select({ id: staff.id, name: staff.name, level: staff.level })
      .from(staff)
      .where(eq(staff.active, true))
      .orderBy(asc(staff.name), asc(staff.id)),
    db.select().from(serviceStaff).where(inArray(serviceStaff.serviceId, serviceIds)),
    db.select().from(serviceLevelPrice).where(inArray(serviceLevelPrice.serviceId, serviceIds)),
    db
      .selectDistinct({
        staffId: availabilityRule.staffId,
        locationId: availabilityRule.locationId,
      })
      .from(availabilityRule)
      .where(
        and(
          inArray(availabilityRule.locationId, locationIds),
          or(isNull(availabilityRule.validTo), gte(availabilityRule.validTo, today)),
        ),
      ),
  ]);

  const works = new Set(rules.map((r) => `${r.staffId}|${r.locationId}`));
  const offerOf = new Map(offers.map((o) => [`${o.serviceId}|${o.staffId}`, o]));
  const levelOf = new Map(levels.map((l) => [`${l.serviceId}|${l.level}`, l]));

  for (const [locationId, services] of locations) {
    const list: CatalogStaff[] = [];
    for (const person of people) {
      if (!works.has(`${person.id}|${locationId}`)) continue;
      const priced: CatalogStaff["offers"] = {};
      for (const svc of services) {
        const own = offerOf.get(`${svc.id}|${person.id}`);
        if (!own) continue;
        priced[svc.id] = priceFor(svc, own, levelOf.get(`${svc.id}|${person.level}`));
      }
      if (Object.keys(priced).length > 0) {
        list.push({ id: person.id, name: person.name, offers: priced });
      }
    }
    result.set(locationId, list);
  }
  return result;
}
