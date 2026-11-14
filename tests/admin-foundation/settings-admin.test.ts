import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb } from "../helpers/test-db";
import { seedBasics } from "../helpers/factories";
import { auditLog, business } from "@/db/schema";
import {
  getAdminSettings,
  nextPolicyVersion,
  settingsInputSchema,
  updateSettings,
} from "@/server/admin-foundation/settings-admin";
import { getBusinessSettings } from "@/server/settings";
import type { Actor } from "@/server/audit";

const actor: Actor = "owner:user-1";

describe("nextPolicyVersion", () => {
  test("increments numeric versions", () => {
    expect(nextPolicyVersion("1")).toBe("2");
    expect(nextPolicyVersion("9")).toBe("10");
  });
  test("recovers from a non-numeric version", () => {
    expect(nextPolicyVersion("v2-draft")).toBe("2");
    expect(nextPolicyVersion("")).toBe("2");
  });
});

describe("business settings admin", () => {
  let h: Awaited<ReturnType<typeof createTestDb>>;
  let bizId: string;

  beforeEach(async () => {
    h = await createTestDb();
    bizId = (await seedBasics(h.db)).biz.id;
  });
  afterEach(async () => {
    await h.client.close();
  });

  const full = {
    slotStepMin: 15,
    depositPct: 40,
    cancelWindowHours: 48,
    extraFeePct: 10,
    refundOutsideWindow: "credit" as const,
    minNoticeMin: 180,
    maxAdvanceDays: 60,
    holdMinutes: 15,
    reminderHoursBefore: 24,
    cashDiscountPct: 5,
    chooseStaff: true,
    policyText: "24 hours notice please.",
  };

  test("returns defaults for a fresh business", async () => {
    const { settings } = await getAdminSettings(h.db);
    expect(settings).toMatchObject({ depositPct: 50, policyVersion: "1", policyText: "" });
  });

  test("saves every field and audits who changed what", async () => {
    await updateSettings(h.db, actor, settingsInputSchema.parse(full));
    expect(await getBusinessSettings(h.db, bizId)).toMatchObject({
      ...full,
      policyVersion: "2",
    });
    const [entry] = await h.db.select().from(auditLog);
    expect(entry).toMatchObject({
      actor: "owner:user-1",
      action: "settings.updated",
      entityType: "business",
      entityId: bizId,
    });
    expect(entry?.data.changed).toEqual(expect.arrayContaining(["depositPct", "policyText"]));
  });

  test("bumps the policy version only when the policy text actually changes", async () => {
    await updateSettings(h.db, actor, settingsInputSchema.parse(full));
    expect((await getBusinessSettings(h.db, bizId)).policyVersion).toBe("2");

    // same text, other field changed: no bump
    await updateSettings(h.db, actor, settingsInputSchema.parse({ ...full, depositPct: 30 }));
    expect((await getBusinessSettings(h.db, bizId)).policyVersion).toBe("2");

    // whitespace-only difference: no bump
    await updateSettings(
      h.db,
      actor,
      settingsInputSchema.parse({
        ...full,
        depositPct: 30,
        policyText: "  24 hours notice please.\n",
      }),
    );
    expect((await getBusinessSettings(h.db, bizId)).policyVersion).toBe("2");

    // real edit: bump
    await updateSettings(
      h.db,
      actor,
      settingsInputSchema.parse({ ...full, depositPct: 30, policyText: "48 hours notice please." }),
    );
    const after = await getBusinessSettings(h.db, bizId);
    expect(after.policyVersion).toBe("3");
    expect(after.policyText).toBe("48 hours notice please.");
  });

  test("does not let the form set policyVersion directly", async () => {
    const parsed = settingsInputSchema.parse({ ...full, policyVersion: "99" });
    expect("policyVersion" in parsed).toBe(false);
    await updateSettings(h.db, actor, parsed);
    expect((await getBusinessSettings(h.db, bizId)).policyVersion).toBe("2");
  });

  test("keeps unrelated keys already stored on the settings JSON", async () => {
    await h.db
      .update(business)
      .set({ settings: { depositPct: 20, somethingElse: "keep me" } })
      .where(eq(business.id, bizId));
    await updateSettings(h.db, actor, settingsInputSchema.parse(full));
    const [row] = await h.db.select().from(business).where(eq(business.id, bizId));
    expect(row?.settings.somethingElse).toBe("keep me");
  });

  test("an unchanged save records no audit noise", async () => {
    await updateSettings(h.db, actor, settingsInputSchema.parse(full));
    await updateSettings(h.db, actor, settingsInputSchema.parse(full));
    expect(await h.db.select().from(auditLog)).toHaveLength(1);
  });

  test("validation rejects out-of-range values", () => {
    expect(settingsInputSchema.safeParse({ ...full, depositPct: 101 }).success).toBe(false);
    expect(settingsInputSchema.safeParse({ ...full, cancelWindowHours: -1 }).success).toBe(false);
    expect(settingsInputSchema.safeParse({ ...full, holdMinutes: 0 }).success).toBe(false);
    expect(settingsInputSchema.safeParse({ ...full, policyText: "x".repeat(6001) }).success).toBe(
      false,
    );
  });
});
