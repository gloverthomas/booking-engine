import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { auditLog, serviceLevelPrice } from "@/db/schema";
import { getService, listServices, saveService } from "@/server/admin-foundation/catalog";
import {
  serviceInputSchema,
  type ServiceFormInput,
} from "@/server/admin-foundation/catalog-schemas";
import { isAdminError } from "@/server/admin-foundation/errors";
import { createStaff, seedBasics } from "../helpers/factories";
import { createTestDb } from "../helpers/test-db";

type Harness = Awaited<ReturnType<typeof createTestDb>>;

describe("seniority price table", () => {
  let h: Harness;
  let fx: Awaited<ReturnType<typeof seedBasics>>;

  beforeEach(async () => {
    h = await createTestDb();
    fx = await seedBasics(h.db);
  });
  afterEach(async () => {
    await h.client.close();
  });

  function formInput(overrides: Partial<ServiceFormInput> = {}): ServiceFormInput {
    return {
      name: "Maintenance Haircut",
      durationMin: 45,
      price: "95",
      locationIds: [fx.loc.id],
      staff: [{ staffId: fx.stylist.id }],
      ...overrides,
    };
  }

  describe("validation", () => {
    test("turns dollars into cents and treats blanks as inherit", () => {
      const parsed = serviceInputSchema.parse(
        formInput({
          levelPrices: [
            { level: 1, price: "$75", durationMin: 60 },
            { level: 2, price: "", durationMin: null },
          ],
        }),
      );
      expect(parsed.levelPrices).toEqual([
        { level: 1, priceCents: 7500, durationMin: 60 },
        { level: 2, priceCents: null, durationMin: null },
      ]);
    });

    test("leaves levelPrices undefined when the form does not send it", () => {
      expect(serviceInputSchema.parse(formInput()).levelPrices).toBeUndefined();
    });

    test("rejects duplicate levels, bad prices and out-of-range values", () => {
      const dup = serviceInputSchema.safeParse(
        formInput({
          levelPrices: [
            { level: 1, price: "70" },
            { level: 1, price: "80" },
          ],
        }),
      );
      expect(dup.success).toBe(false);
      expect(
        serviceInputSchema.safeParse(formInput({ levelPrices: [{ level: 1, price: "cheap" }] }))
          .success,
      ).toBe(false);
      expect(
        serviceInputSchema.safeParse(formInput({ levelPrices: [{ level: -1, price: "70" }] }))
          .success,
      ).toBe(false);
      expect(
        serviceInputSchema.safeParse(
          formInput({ levelPrices: [{ level: 1, price: "70", durationMin: 2 }] }),
        ).success,
      ).toBe(false);
    });
  });

  describe("saving", () => {
    test("writes one row per filled-in level and skips fully blank rows", async () => {
      const { id } = await saveService(
        h.db,
        "owner:u1",
        serviceInputSchema.parse(
          formInput({
            levelPrices: [
              { level: 0, price: "", durationMin: null },
              { level: 1, price: "75", durationMin: null },
              { level: 2, price: "", durationMin: 50 },
            ],
          }),
        ),
      );
      const rows = await h.db
        .select()
        .from(serviceLevelPrice)
        .where(eq(serviceLevelPrice.serviceId, id));
      expect(rows.map((r) => [r.level, r.priceCents, r.durationMin]).sort()).toEqual([
        [1, 7500, null],
        [2, null, 50],
      ]);
    });

    test("replaces the table on update and clears it when every row is blank", async () => {
      const { id } = await saveService(
        h.db,
        "owner:u1",
        serviceInputSchema.parse(formInput({ levelPrices: [{ level: 1, price: "75" }] })),
      );
      await saveService(
        h.db,
        "owner:u1",
        serviceInputSchema.parse(
          formInput({
            id,
            levelPrices: [
              { level: 1, price: "80" },
              { level: 2, price: "90" },
            ],
          }),
        ),
      );
      expect((await getService(h.db, id))?.levelPrices).toEqual([
        { level: 1, priceCents: 8000, durationMin: null },
        { level: 2, priceCents: 9000, durationMin: null },
      ]);

      await saveService(
        h.db,
        "owner:u1",
        serviceInputSchema.parse(formInput({ id, levelPrices: [{ level: 1, price: "" }] })),
      );
      expect((await getService(h.db, id))?.levelPrices).toEqual([]);
    });

    test("leaves the table alone when the input does not mention levels", async () => {
      const { id } = await saveService(
        h.db,
        "owner:u1",
        serviceInputSchema.parse(formInput({ levelPrices: [{ level: 1, price: "75" }] })),
      );
      await saveService(h.db, "owner:u1", serviceInputSchema.parse(formInput({ id })));
      expect((await getService(h.db, id))?.levelPrices).toEqual([
        { level: 1, priceCents: 7500, durationMin: null },
      ]);
    });

    test("audits the change with the level count, under the given actor", async () => {
      const { id } = await saveService(
        h.db,
        "staff:u7",
        serviceInputSchema.parse(formInput({ levelPrices: [{ level: 1, price: "75" }] })),
      );
      const [entry] = await h.db.select().from(auditLog).where(eq(auditLog.entityId, id));
      expect(entry.actor).toBe("staff:u7");
      expect(entry.data).toMatchObject({ levelRows: 1 });
    });

    test("lists level rows with each service, ordered by level", async () => {
      const { id } = await saveService(
        h.db,
        "owner:u1",
        serviceInputSchema.parse(
          formInput({
            levelPrices: [
              { level: 2, price: "90" },
              { level: 1, price: "75" },
            ],
          }),
        ),
      );
      const listed = (await listServices(h.db)).find((s) => s.id === id);
      expect(listed?.levelPrices.map((r) => r.level)).toEqual([1, 2]);
    });

    test("deleting the service removes its level rows with it", async () => {
      const { id } = await saveService(
        h.db,
        "owner:u1",
        serviceInputSchema.parse(formInput({ levelPrices: [{ level: 1, price: "75" }] })),
      );
      const { deleteService } = await import("@/server/admin-foundation/catalog");
      await deleteService(h.db, "owner:u1", id);
      expect(await h.db.select().from(serviceLevelPrice)).toEqual([]);
    });
  });

  test("stylists are still validated when saving alongside level prices", async () => {
    const other = await createStaff(h.db, fx.biz.id, { name: "Bea", email: "bea@example.com" });
    const parsed = serviceInputSchema.parse(
      formInput({ staff: [{ staffId: other.id, price: "70" }] }),
    );
    await expect(
      saveService(h.db, "owner:u1", {
        ...parsed,
        staff: [
          { staffId: "00000000-0000-4000-8000-000000000000", priceCents: null, durationMin: null },
        ],
      }),
    ).rejects.toSatisfy(isAdminError);
  });
});
