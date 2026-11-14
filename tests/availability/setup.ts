import { eq } from "drizzle-orm";
import { DateTime } from "luxon";
import {
  availabilityRule,
  booking,
  business,
  serviceLocation,
  serviceStaff,
  staff,
  timeBlock,
} from "@/db/schema";
import type { Db } from "@/server/db-types";
import { createService, seedBasics } from "../helpers/factories";
import { createTestDb } from "../helpers/test-db";

export const ZONE = "Australia/Melbourne";

/** A Date for a local wall-clock time in Melbourne, e.g. local("2026-11-02T09:00"). */
export const local = (iso: string): Date => DateTime.fromISO(iso, { zone: ZONE }).toJSDate();
export const localTime = (d: Date): string =>
  DateTime.fromJSDate(d, { zone: ZONE }).toFormat("HH:mm");

/** Sunday 2026-11-01, 08:00 Melbourne. Monday 2026-11-02 is the first bookable day in most tests. */
export const NOW = local("2026-11-01T08:00");
export const MONDAY = "2026-11-02";

export type TestDb = Awaited<ReturnType<typeof createTestDb>>;

export interface World {
  t: TestDb;
  db: Db;
  businessId: string;
  locationId: string;
  staffId: string;
  clientId: string;
  /** Maintenance Haircut: 45 min, $95, no buffer, offered at the location by the stylist. */
  haircutId: string;
}

/** Link a service to a location and a staff member. */
export async function offer(
  db: Db,
  serviceId: string,
  locationId: string,
  staffId: string,
  override: { priceCents?: number; durationMin?: number } = {},
) {
  await db.insert(serviceLocation).values({ serviceId, locationId }).onConflictDoNothing();
  await db.insert(serviceStaff).values({
    serviceId,
    staffId,
    priceCents: override.priceCents ?? null,
    durationMin: override.durationMin ?? null,
  });
}

/** Mon-Sun, 09:00-17:00 for a staff member at a location. */
export async function openEveryDay(
  db: Db,
  staffId: string,
  locationId: string,
  startMinute = 540,
  endMinute = 1020,
) {
  for (let weekday = 0; weekday <= 6; weekday += 1) {
    await db
      .insert(availabilityRule)
      .values({ staffId, locationId, weekday, startMinute, endMinute });
  }
}

export async function setSettings(db: Db, businessId: string, settings: Record<string, unknown>) {
  await db.update(business).set({ settings }).where(eq(business.id, businessId));
}

/** Fresh in-process Postgres with one business, location, stylist (open daily 9-5) and a haircut. */
export async function createWorld(settings: Record<string, unknown> = {}): Promise<World> {
  const t = await createTestDb();
  const { biz, loc, stylist, cl } = await seedBasics(t.db);
  await setSettings(t.db, biz.id, settings);
  const haircut = await createService(t.db, biz.id);
  await offer(t.db, haircut.id, loc.id, stylist.id);
  await openEveryDay(t.db, stylist.id, loc.id);
  return {
    t,
    db: t.db,
    businessId: biz.id,
    locationId: loc.id,
    staffId: stylist.id,
    clientId: cl.id,
    haircutId: haircut.id,
  };
}

export async function addStaff(db: Db, businessId: string, name: string) {
  const [row] = await db.insert(staff).values({ businessId, name }).returning();
  return row;
}

export async function addBooking(
  db: Db,
  w: Pick<World, "locationId" | "clientId" | "staffId">,
  start: Date,
  end: Date,
  overrides: Partial<typeof booking.$inferInsert> = {},
) {
  const [row] = await db
    .insert(booking)
    .values({
      staffId: w.staffId,
      locationId: w.locationId,
      clientId: w.clientId,
      status: "confirmed",
      during: { start, end },
      ...overrides,
    })
    .returning();
  return row;
}

export async function addBlock(db: Db, staffId: string, start: Date, end: Date) {
  const [row] = await db
    .insert(timeBlock)
    .values({ staffId, during: { start, end }, reason: "test" })
    .returning();
  return row;
}
