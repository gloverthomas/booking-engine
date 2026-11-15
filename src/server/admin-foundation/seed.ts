import { and, eq } from "drizzle-orm";
import {
  availabilityRule,
  business,
  location,
  service,
  serviceLocation,
  serviceStaff,
  staff,
} from "@/db/schema";
import { recordAudit } from "@/server/audit";
import type { Db } from "@/server/db-types";
import { parseSettings } from "@/server/settings";

export const BUSINESS_NAME = "Ryan Kennedy Hairdressing";

/** Policy carried over from the current booking page (PLAN.md Appendix A). Versioned by the settings form. */
export const POLICY_TEXT = [
  "24 hours' notice is required to change or cancel a booking.",
  "A 50% booking fee is deducted from the price of your service. It is forfeited if you cancel or change inside 24 hours, or do not show up.",
  "If you arrive late your appointment may be cancelled and the booking fee forfeited.",
  "Bookings can be moved by up to 15 minutes either way with notice, but not within 48 hours of the appointment.",
].join("\n\n");

const LOCATIONS = [
  {
    name: "Northside (Lola Fortune)",
    addressLine: "302 Rathdowne Street",
    suburb: "Carlton North",
    state: "VIC",
    postcode: "3054",
  },
  {
    name: "South side (High Barber)",
    addressLine: "249 High Street",
    suburb: "Prahran",
    state: "VIC",
    postcode: "3181",
  },
] as const;

const SERVICES = [
  { name: "Maintenance Haircut", durationMin: 45, priceCents: 9500 },
  { name: "Beard Trim", durationMin: 15, priceCents: 3000 },
  { name: "Restructure/Restyle", durationMin: 60, priceCents: 12600 },
  { name: "Bang Trim", durationMin: 20, priceCents: 4500 },
  { name: "Clipper Back And Sides Freshen Up", durationMin: 30, priceCents: 6500 },
] as const;

/**
 * Sample week for a fresh install: Monday to Wednesday at Northside, Thursday to Saturday on the South side.
 * Minutes are local to the business timezone. The owner edits these on the Hours screen.
 */
const SAMPLE_HOURS: ReadonlyArray<{
  weekday: number;
  locationIndex: number;
  startMinute: number;
  endMinute: number;
}> = [
  { weekday: 1, locationIndex: 0, startMinute: 9 * 60, endMinute: 17 * 60 },
  { weekday: 2, locationIndex: 0, startMinute: 9 * 60, endMinute: 17 * 60 },
  { weekday: 3, locationIndex: 0, startMinute: 9 * 60, endMinute: 17 * 60 },
  { weekday: 4, locationIndex: 1, startMinute: 9 * 60, endMinute: 17 * 60 },
  { weekday: 5, locationIndex: 1, startMinute: 9 * 60, endMinute: 17 * 60 },
  { weekday: 6, locationIndex: 1, startMinute: 9 * 60, endMinute: 16 * 60 },
];

export interface SeedResult {
  businessId: string;
  created: { business: boolean; locations: number; staff: boolean; services: number };
}

/**
 * Idempotent: each record is created only when it is missing (matched by name), and dependent rows
 * (offerings, sample hours) are only added alongside a newly created parent. Re-running never
 * overwrites changes the owner has made through the admin.
 */
export async function seedDatabase(db: Db): Promise<SeedResult> {
  return db.transaction(async (tx) => {
    // Business
    let [biz] = await tx.select().from(business).where(eq(business.name, BUSINESS_NAME));
    const businessCreated = !biz;
    if (!biz) {
      [biz] = await tx
        .insert(business)
        .values({
          name: BUSINESS_NAME,
          timezone: "Australia/Melbourne",
          settings: parseSettings({ policyText: POLICY_TEXT }),
        })
        .returning();
    }
    if (!biz) throw new Error("Could not create the business");

    // Locations
    const locationIds: string[] = [];
    let locationsCreated = 0;
    for (const [index, spec] of LOCATIONS.entries()) {
      let [row] = await tx
        .select()
        .from(location)
        .where(and(eq(location.businessId, biz.id), eq(location.name, spec.name)));
      if (!row) {
        [row] = await tx
          .insert(location)
          .values({ ...spec, businessId: biz.id, sortOrder: index })
          .returning();
        locationsCreated += 1;
      }
      if (!row) throw new Error(`Could not create location ${spec.name}`);
      locationIds.push(row.id);
    }

    // Staff
    let [ryan] = await tx
      .select()
      .from(staff)
      .where(and(eq(staff.businessId, biz.id), eq(staff.name, "Ryan")));
    const staffCreated = !ryan;
    if (!ryan) {
      [ryan] = await tx
        .insert(staff)
        .values({ businessId: biz.id, name: "Ryan", role: "owner" })
        .returning();
    }
    if (!ryan) throw new Error("Could not create the stylist");

    // Services, offered at both locations by Ryan
    let servicesCreated = 0;
    for (const [index, spec] of SERVICES.entries()) {
      const [existing] = await tx
        .select({ id: service.id })
        .from(service)
        .where(and(eq(service.businessId, biz.id), eq(service.name, spec.name)));
      if (existing) continue;
      const [row] = await tx
        .insert(service)
        .values({ ...spec, businessId: biz.id, sortOrder: index })
        .returning({ id: service.id });
      if (!row) throw new Error(`Could not create service ${spec.name}`);
      servicesCreated += 1;
      await tx
        .insert(serviceLocation)
        .values(locationIds.map((locationId) => ({ serviceId: row.id, locationId })));
      await tx.insert(serviceStaff).values({ serviceId: row.id, staffId: ryan.id });
    }

    // Sample hours, only for a stylist created by this seed
    if (staffCreated) {
      await tx.insert(availabilityRule).values(
        SAMPLE_HOURS.map((hours) => ({
          staffId: ryan.id,
          locationId: locationIds[hours.locationIndex] as string,
          weekday: hours.weekday,
          startMinute: hours.startMinute,
          endMinute: hours.endMinute,
        })),
      );
    }

    const created = {
      business: businessCreated,
      locations: locationsCreated,
      staff: staffCreated,
      services: servicesCreated,
    };
    const changedAnything =
      businessCreated || locationsCreated > 0 || staffCreated || servicesCreated > 0;
    if (changedAnything) {
      await recordAudit(tx, {
        actor: "system",
        action: "seed.applied",
        entityType: "business",
        entityId: biz.id,
        data: created,
      });
    }
    return { businessId: biz.id, created };
  });
}
