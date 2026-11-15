import type { AccessContext } from "@/server/admin/access";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb } from "../helpers/test-db";
import { seedBasics } from "../helpers/factories";
import { auditLog, booking, bookingService, client, payment } from "@/db/schema";
import {
  getClientProfile,
  searchClients,
  setClientBlocked,
  setClientVip,
  updateClientNotes,
} from "@/server/admin/clients";

const OWNER: AccessContext = { role: "owner", staffId: null };

type TestDb = Awaited<ReturnType<typeof createTestDb>>;
let t: TestDb;
let seed: Awaited<ReturnType<typeof seedBasics>>;
const NOW = new Date("2026-11-14T00:00:00Z");
const actor = "owner:u1" as const;

async function addClient(values: Partial<typeof client.$inferInsert>) {
  const [row] = await t.db
    .insert(client)
    .values({ businessId: seed.biz.id, firstName: "X", ...values })
    .returning();
  return row;
}

async function addBooking(
  clientId: string,
  status: typeof booking.$inferInsert.status,
  day: number,
) {
  const d = String(day).padStart(2, "0");
  const [row] = await t.db
    .insert(booking)
    .values({
      staffId: seed.stylist.id,
      locationId: seed.loc.id,
      clientId,
      status,
      during: {
        start: new Date(`2026-11-${d}T03:00:00Z`),
        end: new Date(`2026-11-${d}T04:00:00Z`),
      },
      totalCents: 10000,
    })
    .returning();
  return row;
}

beforeEach(async () => {
  t = await createTestDb();
  seed = await seedBasics(t.db);
});
afterEach(async () => {
  await t.client.close();
});

describe("searchClients", () => {
  test("matches name, email and phone and skips merged duplicates", async () => {
    const jo = await addClient({
      firstName: "Jo",
      lastName: "Smith",
      email: "jo@example.com",
      phone: "+61411222333",
      isVip: true,
    });
    await addClient({ firstName: "Jo", lastName: "Smith", mergedIntoId: jo.id });

    const byName = await searchClients(t.db, OWNER, { q: "jo smi" });
    expect(byName).toEqual([
      {
        id: jo.id,
        name: "Jo Smith",
        email: "jo@example.com",
        phone: "+61411222333",
        isVip: true,
        blocked: false,
      },
    ]);
    expect((await searchClients(t.db, OWNER, { q: "0411 222 333" })).map((c) => c.id)).toEqual([
      jo.id,
    ]);
    expect((await searchClients(t.db, OWNER, { q: "jo@exam" })).map((c) => c.id)).toEqual([jo.id]);
    expect(await searchClients(t.db, OWNER, { q: "nobody" })).toEqual([]);
  });

  test("an empty query lists clients alphabetically, honouring the limit", async () => {
    await addClient({ firstName: "Zed", lastName: "Last" });
    await addClient({ firstName: "Amy", lastName: "First" });
    const all = await searchClients(t.db, OWNER, { q: "" });
    expect(all.map((c) => c.name)).toEqual(["Amy First", "Sam Client", "Zed Last"]);
    expect(await searchClients(t.db, OWNER, { q: "", limit: 1 })).toHaveLength(1);
  });
});

describe("getClientProfile", () => {
  test("returns null for an unknown client", async () => {
    expect(await getClientProfile(t.db, crypto.randomUUID(), OWNER, NOW)).toBeNull();
  });

  test("counts outcomes, upcoming visits and lifetime spend", async () => {
    const done1 = await addBooking(seed.cl.id, "completed", 1);
    const done2 = await addBooking(seed.cl.id, "completed", 2);
    await addBooking(seed.cl.id, "no_show", 3);
    await addBooking(seed.cl.id, "late_cancelled", 4);
    await addBooking(seed.cl.id, "cancelled_by_client", 5);
    await addBooking(seed.cl.id, "confirmed", 20);
    await t.db.insert(bookingService).values({
      bookingId: done1.id,
      name: "Cut",
      durationMin: 45,
      priceCents: 100,
    });
    await t.db.insert(payment).values([
      {
        bookingId: done1.id,
        kind: "deposit",
        method: "stripe_online",
        status: "succeeded",
        amountCents: 5000,
      },
      {
        bookingId: done1.id,
        kind: "balance",
        method: "cash",
        status: "succeeded",
        amountCents: 4500,
      },
      {
        bookingId: done2.id,
        kind: "balance",
        method: "eftpos",
        status: "succeeded",
        amountCents: 10000,
      },
      {
        bookingId: done2.id,
        kind: "refund",
        method: "stripe_online",
        status: "succeeded",
        amountCents: 1000,
      },
    ]);

    const profile = await getClientProfile(t.db, seed.cl.id, OWNER, NOW);

    expect(profile).toMatchObject({
      id: seed.cl.id,
      name: "Sam Client",
      email: "sam@example.com",
      mergedIntoId: null,
      stats: {
        completedCount: 2,
        noShowCount: 1,
        lateCancelCount: 1,
        cancelledCount: 1,
        upcomingCount: 1,
        lifetimeSpendCents: 18500,
      },
    });
    expect(profile?.history).toHaveLength(6);
    expect(profile?.history[0].start).toBe("2026-11-20T03:00:00.000Z");
    expect(profile?.history.find((h) => h.id === done2.id)?.services).toEqual([]);
    expect(profile?.history.find((h) => h.id === done1.id)?.services).toEqual(["Cut"]);
  });

  test("exposes the merge target for merged records", async () => {
    const dup = await addClient({ firstName: "Dup", mergedIntoId: seed.cl.id });
    const profile = await getClientProfile(t.db, dup.id, OWNER, NOW);
    expect(profile?.mergedIntoId).toBe(seed.cl.id);
  });
});

describe("client mutations", () => {
  test("updateClientNotes trims, stores and audits without logging the note text", async () => {
    await updateClientNotes(t.db, seed.cl.id, "  Cut formula: #2 guard  ", actor, OWNER);

    const [row] = await t.db.select().from(client).where(eq(client.id, seed.cl.id));
    expect(row.notes).toBe("Cut formula: #2 guard");
    const [audit] = await t.db.select().from(auditLog);
    expect(audit).toMatchObject({ actor, action: "client.notes_updated", entityType: "client" });
    expect(JSON.stringify(audit.data)).not.toContain("guard");
  });

  test("blank notes are stored as null", async () => {
    await updateClientNotes(t.db, seed.cl.id, "   ", actor, OWNER);
    const [row] = await t.db.select().from(client).where(eq(client.id, seed.cl.id));
    expect(row.notes).toBeNull();
  });

  test("setClientBlocked and setClientVip update the flags and audit", async () => {
    await setClientBlocked(t.db, seed.cl.id, true, actor, OWNER);
    await setClientVip(t.db, seed.cl.id, true, actor, OWNER);
    const [row] = await t.db.select().from(client).where(eq(client.id, seed.cl.id));
    expect(row).toMatchObject({ blocked: true, isVip: true });
    const actions = (await t.db.select().from(auditLog)).map((a) => a.action).sort();
    expect(actions).toEqual(["client.blocked_changed", "client.vip_changed"]);

    await setClientBlocked(t.db, seed.cl.id, false, actor, OWNER);
    const [after] = await t.db.select().from(client).where(eq(client.id, seed.cl.id));
    expect(after.blocked).toBe(false);
  });

  test("mutating an unknown client is a friendly error", async () => {
    await expect(updateClientNotes(t.db, crypto.randomUUID(), "x", actor, OWNER)).rejects.toThrow(
      /client was not found/i,
    );
    await expect(setClientBlocked(t.db, crypto.randomUUID(), true, actor, OWNER)).rejects.toThrow(
      /client was not found/i,
    );
  });
});
