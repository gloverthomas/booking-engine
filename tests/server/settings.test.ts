import { describe, expect, test } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb } from "../helpers/test-db";
import { seedBasics } from "../helpers/factories";
import { business } from "@/db/schema";
import { getBusinessSettings, parseSettings } from "@/server/settings";

describe("business settings", () => {
  test("empty settings resolve to the documented defaults", () => {
    const s = parseSettings({});
    expect(s).toMatchObject({
      slotStepMin: 15,
      depositPct: 50,
      cancelWindowHours: 24,
      holdMinutes: 10,
      chooseStaff: false,
      waitlistEnabled: true,
      waitlistAutoOffer: true,
      waitlistOfferWindowMin: 20,
      waitlistMaxOffersPerSlot: 5,
      staffAlertsEnabled: true,
    });
  });

  test("rejects invalid values", () => {
    expect(() => parseSettings({ depositPct: 150 })).toThrow();
    expect(() => parseSettings({ slotStepMin: 1 })).toThrow();
  });

  test("reads and parses settings stored on the business row", async () => {
    const { db, client } = await createTestDb();
    const { biz } = await seedBasics(db);
    await db
      .update(business)
      .set({ settings: { depositPct: 30 } })
      .where(eq(business.id, biz.id));
    expect((await getBusinessSettings(db, biz.id)).depositPct).toBe(30);
    await expect(getBusinessSettings(db, "00000000-0000-0000-0000-000000000000")).rejects.toThrow(
      /not found/,
    );
    await client.close();
  });
});
