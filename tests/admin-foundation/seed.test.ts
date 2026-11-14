import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createTestDb } from "../helpers/test-db";
import {
  auditLog,
  availabilityRule,
  business,
  location,
  service,
  serviceLocation,
  serviceStaff,
  staff,
} from "@/db/schema";
import { POLICY_TEXT, seedDatabase } from "@/server/admin-foundation/seed";
import { getBusinessSettings } from "@/server/settings";

describe("seedDatabase", () => {
  let h: Awaited<ReturnType<typeof createTestDb>>;
  beforeEach(async () => {
    h = await createTestDb();
  });
  afterEach(async () => {
    await h.client.close();
  });

  test("creates the business, both locations, Ryan, five services and sample hours", async () => {
    const result = await seedDatabase(h.db);

    const [biz] = await h.db.select().from(business);
    expect(biz).toMatchObject({
      name: "Ryan Kennedy Hairdressing",
      timezone: "Australia/Melbourne",
    });
    expect(result.businessId).toBe(biz?.id);

    const settings = await getBusinessSettings(h.db, biz!.id);
    expect(settings).toMatchObject({
      depositPct: 50,
      cancelWindowHours: 24,
      policyVersion: "1",
      policyText: POLICY_TEXT,
    });

    const locations = await h.db.select().from(location);
    expect(locations.map((l) => l.name).sort()).toEqual([
      "Northside (Lola Fortune)",
      "South side (High Barber)",
    ]);
    const northside = locations.find((l) => l.name.startsWith("Northside"));
    expect(northside).toMatchObject({
      addressLine: "302 Rathdowne Street",
      suburb: "Carlton North",
      state: "VIC",
      postcode: "3054",
    });
    expect(locations.find((l) => l.name.startsWith("South"))).toMatchObject({
      addressLine: "249 High Street",
      suburb: "Prahran",
      postcode: "3181",
    });

    const [ryan] = await h.db.select().from(staff);
    expect(ryan?.name).toBe("Ryan");

    const services = await h.db.select().from(service);
    const byName = Object.fromEntries(services.map((s) => [s.name, s]));
    expect(Object.keys(byName).sort()).toEqual([
      "Bang Trim",
      "Beard Trim",
      "Clipper Back And Sides Freshen Up",
      "Maintenance Haircut",
      "Restructure/Restyle",
    ]);
    expect(byName["Maintenance Haircut"]).toMatchObject({ durationMin: 45, priceCents: 9500 });
    expect(byName["Beard Trim"]).toMatchObject({ durationMin: 15, priceCents: 3000 });
    expect(byName["Restructure/Restyle"]).toMatchObject({ durationMin: 60, priceCents: 12600 });
    expect(byName["Bang Trim"]).toMatchObject({ durationMin: 20, priceCents: 4500 });
    expect(byName["Clipper Back And Sides Freshen Up"]).toMatchObject({
      durationMin: 30,
      priceCents: 6500,
    });

    expect(await h.db.select().from(serviceLocation)).toHaveLength(10);
    expect(await h.db.select().from(serviceStaff)).toHaveLength(5);

    const rules = await h.db.select().from(availabilityRule);
    const days = new Set(rules.map((r) => r.weekday));
    expect([...days].sort()).toEqual([1, 2, 3, 4, 5, 6]);
    expect(rules.every((r) => r.startMinute < r.endMinute)).toBe(true);
  });

  test("is idempotent: running twice adds nothing", async () => {
    await seedDatabase(h.db);
    const counts = async () => ({
      business: (await h.db.select().from(business)).length,
      location: (await h.db.select().from(location)).length,
      staff: (await h.db.select().from(staff)).length,
      service: (await h.db.select().from(service)).length,
      links: (await h.db.select().from(serviceLocation)).length,
      offers: (await h.db.select().from(serviceStaff)).length,
      rules: (await h.db.select().from(availabilityRule)).length,
    });
    const first = await counts();
    await seedDatabase(h.db);
    expect(await counts()).toEqual(first);
  });

  test("does not overwrite edits the owner has made since the first seed", async () => {
    await seedDatabase(h.db);
    const { eq } = await import("drizzle-orm");
    await h.db.update(service).set({ priceCents: 10000 }).where(eq(service.name, "Beard Trim"));
    await h.db.delete(availabilityRule);
    await seedDatabase(h.db);
    const [beard] = await h.db.select().from(service).where(eq(service.name, "Beard Trim"));
    expect(beard?.priceCents).toBe(10000);
    expect(await h.db.select().from(availabilityRule)).toHaveLength(0);
  });

  test("records the seed in the audit log as the system", async () => {
    await seedDatabase(h.db);
    const entries = await h.db.select().from(auditLog);
    expect(entries.some((e) => e.actor === "system" && e.action === "seed.applied")).toBe(true);
  });
});
