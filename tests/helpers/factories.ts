import { business, client, location, service, staff } from "@/db/schema";
import type { Db } from "@/server/db-types";

/** Minimal fixtures for DB tests. Override any field. */
export async function seedBasics(db: Db) {
  const [biz] = await db.insert(business).values({ name: "Test Business" }).returning();
  const [loc] = await db
    .insert(location)
    .values({ businessId: biz.id, name: "Northside" })
    .returning();
  const [stylist] = await db
    .insert(staff)
    .values({ businessId: biz.id, name: "Ryan", role: "owner" })
    .returning();
  const [cl] = await db
    .insert(client)
    .values({ businessId: biz.id, firstName: "Sam", lastName: "Client", email: "sam@example.com" })
    .returning();
  return { biz, loc, stylist, cl };
}

export async function createService(
  db: Db,
  businessId: string,
  overrides: Partial<typeof service.$inferInsert> = {},
) {
  const [row] = await db
    .insert(service)
    .values({
      businessId,
      name: "Maintenance Haircut",
      durationMin: 45,
      priceCents: 9500,
      ...overrides,
    })
    .returning();
  return row;
}

/** Another staff member at the same business. */
export async function createStaff(
  db: Db,
  businessId: string,
  overrides: Partial<typeof staff.$inferInsert> = {},
) {
  const [row] = await db
    .insert(staff)
    .values({ businessId, name: "Alex", role: "stylist", email: "alex@example.com", ...overrides })
    .returning();
  return row;
}
