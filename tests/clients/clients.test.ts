import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { booking, client, domainEvent, auditLog, messageLog } from "@/db/schema";
import { ClientMergeError, NotFoundError, ValidationError } from "@/server/booking/errors";
import { findOrCreateClient, mergeClients, normalizeEmail, normalizePhone } from "@/server/clients";
import { addBooking, createWorld, local, type World } from "../availability/setup";

let w: World;

beforeEach(async () => {
  w = await createWorld();
});
afterEach(async () => {
  await w.t.client.close();
});

const input = (overrides: Record<string, unknown> = {}) => ({
  firstName: "Alex",
  lastName: "Nguyen",
  email: "Alex.Nguyen@Example.com ",
  phone: "0412 345 678",
  ...overrides,
});

describe("normalizePhone / normalizeEmail", () => {
  test.each([
    ["0412 345 678", "+61412345678"],
    ["0412345678", "+61412345678"],
    ["+61 412 345 678", "+61412345678"],
    ["(03) 9123 4567", "+61391234567"],
    ["61412345678", "+61412345678"],
  ])("normalises %s to E.164 (%s)", (raw, expected) => {
    expect(normalizePhone(raw)).toBe(expected);
  });

  test.each(["", "abc", "12345", "0412 345", "+61 99 999"])("rejects %j", (raw) => {
    expect(normalizePhone(raw)).toBeNull();
  });

  test("lower-cases and trims email, rejects junk", () => {
    expect(normalizeEmail("  Foo@Bar.COM ")).toBe("foo@bar.com");
    expect(normalizeEmail("not-an-email")).toBeNull();
    expect(normalizeEmail("")).toBeNull();
  });
});

describe("findOrCreateClient: create", () => {
  test("creates a client with normalised email and phone", async () => {
    const created = await findOrCreateClient(w.db, input({ pronouns: "they/them" }));
    expect(created).toMatchObject({
      firstName: "Alex",
      lastName: "Nguyen",
      email: "alex.nguyen@example.com",
      phone: "+61412345678",
      pronouns: "they/them",
      marketingOptIn: false,
    });
    expect(created.id).toBeTruthy();
  });

  test("attaches the business id when given and emits client.updated", async () => {
    const created = await findOrCreateClient(w.db, input(), w.businessId);
    expect(created.businessId).toBe(w.businessId);
    const events = await w.db.select().from(domainEvent);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "client.updated", payload: { clientId: created.id } });
  });

  test("respects the marketing opt-in the client chose", async () => {
    const created = await findOrCreateClient(w.db, input({ marketingOptIn: true }));
    expect(created.marketingOptIn).toBe(true);
  });

  test("rejects an invalid phone, invalid email and empty name with a ValidationError", async () => {
    await expect(findOrCreateClient(w.db, input({ phone: "12345" }))).rejects.toBeInstanceOf(
      ValidationError,
    );
    await expect(findOrCreateClient(w.db, input({ email: "nope" }))).rejects.toBeInstanceOf(
      ValidationError,
    );
    await expect(findOrCreateClient(w.db, input({ firstName: "  " }))).rejects.toBeInstanceOf(
      ValidationError,
    );
    expect(await w.db.select().from(client).where(eq(client.firstName, "Alex"))).toHaveLength(0);
  });
});

describe("findOrCreateClient: matching", () => {
  test("matches an existing client by email, ignoring case", async () => {
    const first = await findOrCreateClient(w.db, input());
    const again = await findOrCreateClient(
      w.db,
      input({ email: "ALEX.NGUYEN@example.com", phone: "0499 999 999" }),
    );
    expect(again.id).toBe(first.id);
  });

  test("falls back to the phone number when the email is new", async () => {
    const first = await findOrCreateClient(w.db, input());
    const again = await findOrCreateClient(w.db, input({ email: "alex2@example.com" }));
    expect(again.id).toBe(first.id);
  });

  test("does not overwrite existing contact details with different ones", async () => {
    const first = await findOrCreateClient(w.db, input());
    const again = await findOrCreateClient(w.db, input({ phone: "0499 999 999" }));
    expect(again.id).toBe(first.id);
    expect(again.phone).toBe("+61412345678");
  });

  test("fills a missing phone or email on a matched client", async () => {
    const [bare] = await w.db
      .insert(client)
      .values({ firstName: "Bare", email: "bare@example.com" })
      .returning();
    const matched = await findOrCreateClient(w.db, input({ email: "bare@example.com" }));
    expect(matched.id).toBe(bare.id);
    expect(matched.phone).toBe("+61412345678");
  });

  test("updates name and marketing opt-in but never erases notes", async () => {
    const first = await findOrCreateClient(w.db, input());
    await w.db.update(client).set({ notes: "Allergic to ammonia" }).where(eq(client.id, first.id));
    const updated = await findOrCreateClient(
      w.db,
      input({ firstName: "Alexandra", lastName: "Nguyen-Smith", marketingOptIn: true }),
    );
    expect(updated).toMatchObject({
      id: first.id,
      firstName: "Alexandra",
      lastName: "Nguyen-Smith",
      marketingOptIn: true,
      notes: "Allergic to ammonia",
    });
  });

  test("leaves marketing opt-in alone when the input does not mention it", async () => {
    await findOrCreateClient(w.db, input({ marketingOptIn: true }));
    const again = await findOrCreateClient(w.db, input());
    expect(again.marketingOptIn).toBe(true);
  });

  test("does not write or emit an event when nothing changed", async () => {
    await findOrCreateClient(w.db, input());
    await findOrCreateClient(w.db, input());
    expect(await w.db.select().from(domainEvent)).toHaveLength(1); // only the creation
  });

  test("email match wins over a phone match belonging to someone else", async () => {
    const a = await findOrCreateClient(w.db, input());
    const b = await findOrCreateClient(
      w.db,
      input({ firstName: "Bo", email: "bo@example.com", phone: "0433 111 222" }),
    );
    const matched = await findOrCreateClient(
      w.db,
      input({ email: "bo@example.com", phone: "0412 345 678" }),
    );
    expect(matched.id).toBe(b.id);
    expect(matched.id).not.toBe(a.id);
  });
});

describe("findOrCreateClient: merged clients", () => {
  test("a match on a merged client resolves to the surviving client", async () => {
    const from = await findOrCreateClient(w.db, input());
    const to = await findOrCreateClient(
      w.db,
      input({ email: "other@example.com", phone: "0433 111 222" }),
    );
    await mergeClients(w.db, from.id, to.id);
    const matched = await findOrCreateClient(w.db, input());
    expect(matched.id).toBe(to.id);
  });

  test("follows a chain of merges to the final client", async () => {
    const [a, b, c] = await Promise.all(
      ["a", "b", "c"].map((n, i) =>
        findOrCreateClient(
          w.db,
          input({ email: `${n}@example.com`, phone: `04${i}0 000 000`.replace(/ /g, "") }),
        ),
      ),
    );
    await mergeClients(w.db, a.id, b.id);
    await mergeClients(w.db, b.id, c.id);
    const matched = await findOrCreateClient(w.db, input({ email: "a@example.com" }));
    expect(matched.id).toBe(c.id);
  });

  test("prefers a live client over a merged one with the same email", async () => {
    const merged = await findOrCreateClient(w.db, input());
    const target = await findOrCreateClient(
      w.db,
      input({ email: "target@example.com", phone: "0433 111 222" }),
    );
    await mergeClients(w.db, merged.id, target.id);
    // a fresh live duplicate that reuses the old email
    const [live] = await w.db
      .insert(client)
      .values({ firstName: "Live", email: "alex.nguyen@example.com" })
      .returning();
    const matched = await findOrCreateClient(w.db, input());
    expect(matched.id).toBe(live.id);
  });

  test("a merge cycle does not loop forever", async () => {
    const a = await findOrCreateClient(w.db, input());
    const b = await findOrCreateClient(
      w.db,
      input({ email: "b@example.com", phone: "0433 111 222" }),
    );
    await w.db.update(client).set({ mergedIntoId: b.id }).where(eq(client.id, a.id));
    await w.db.update(client).set({ mergedIntoId: a.id }).where(eq(client.id, b.id));
    const matched = await findOrCreateClient(w.db, input());
    expect([a.id, b.id]).toContain(matched.id);
  });
});

describe("mergeClients", () => {
  async function pair() {
    const from = await findOrCreateClient(w.db, input());
    const to = await findOrCreateClient(
      w.db,
      input({ firstName: "Target", email: "target@example.com", phone: "0433 111 222" }),
    );
    return { from, to };
  }

  test("moves bookings and message history, then marks the source as merged", async () => {
    const { from, to } = await pair();
    const b = await addBooking(
      w.db,
      { ...w, clientId: from.id },
      local("2026-11-02T10:00"),
      local("2026-11-02T10:45"),
    );
    await w.db
      .insert(messageLog)
      .values({ clientId: from.id, channel: "sms", template: "t", toAddress: "+61412345678" });

    await mergeClients(w.db, from.id, to.id, "owner:u1");

    const [moved] = await w.db.select().from(booking).where(eq(booking.id, b.id));
    expect(moved.clientId).toBe(to.id);
    const [msg] = await w.db.select().from(messageLog);
    expect(msg.clientId).toBe(to.id);
    const [source] = await w.db.select().from(client).where(eq(client.id, from.id));
    expect(source.mergedIntoId).toBe(to.id);
    const audit = await w.db.select().from(auditLog).where(eq(auditLog.action, "client.merge"));
    expect(audit).toHaveLength(1);
    expect(audit[0].actor).toBe("owner:u1");
  });

  test("keeps the target's data, fills its gaps and combines flags and notes", async () => {
    const [from] = await w.db
      .insert(client)
      .values({
        firstName: "Old",
        email: "old@example.com",
        phone: "+61400000001",
        notes: "Prefers mornings",
        isVip: true,
        blocked: true,
        stripeCustomerId: "cus_old",
      })
      .returning();
    const [to] = await w.db
      .insert(client)
      .values({ firstName: "New", notes: "Colour allergy" })
      .returning();
    await mergeClients(w.db, from.id, to.id);
    const [merged] = await w.db.select().from(client).where(eq(client.id, to.id));
    expect(merged).toMatchObject({
      firstName: "New",
      email: "old@example.com",
      phone: "+61400000001",
      isVip: true,
      blocked: true,
      stripeCustomerId: "cus_old",
    });
    expect(merged.notes).toContain("Colour allergy");
    expect(merged.notes).toContain("Prefers mornings");
  });

  test("emits client.updated for the surviving client", async () => {
    const { from, to } = await pair();
    await w.db.delete(domainEvent);
    await mergeClients(w.db, from.id, to.id);
    const events = await w.db.select().from(domainEvent);
    expect(events.map((e) => e.payload)).toContainEqual({ clientId: to.id });
  });

  test("rejects merging a client into itself, a missing client, or creating a cycle", async () => {
    const { from, to } = await pair();
    await expect(mergeClients(w.db, from.id, from.id)).rejects.toBeInstanceOf(ClientMergeError);
    await expect(
      mergeClients(w.db, from.id, "00000000-0000-4000-8000-000000000000"),
    ).rejects.toBeInstanceOf(NotFoundError);
    await mergeClients(w.db, from.id, to.id);
    await expect(mergeClients(w.db, to.id, from.id)).rejects.toBeInstanceOf(ClientMergeError);
    await expect(mergeClients(w.db, from.id, to.id)).rejects.toBeInstanceOf(ClientMergeError);
  });
});
