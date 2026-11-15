import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { eq } from "drizzle-orm";
import { booking, bookingService, business, client, deviceToken, staff } from "@/db/schema";
import { handlePushEvent } from "@/server/push";
import {
  ownerIds,
  registerDevice,
  removeDeadTokens,
  tokensFor,
  unregisterDevice,
} from "@/server/push/devices";
import type { PushMessage, PushSender, PushTicket } from "@/server/push/expo";
import { addBooking, addStaff, createWorld, local, type World } from "../availability/setup";

let w: World;
let alexId: string;
const OWNER_TOKEN = "ExponentPushToken[owner]";
const ALEX_TOKEN = "ExponentPushToken[alex]";

class FakeSender implements PushSender {
  sent: PushMessage[] = [];
  tickets: PushTicket[] | null = null;
  async send(messages: readonly PushMessage[]) {
    this.sent.push(...messages);
    return this.tickets ?? messages.map((): PushTicket => ({ status: "ok" }));
  }
}
let sender: FakeSender;
const log = vi.fn();
const run = (data: Record<string, unknown>) => handlePushEvent({ db: w.db, sender, log }, data);

let nextHour = 9;
async function bookingFor(staffId: string, source = "online") {
  const hour = String(nextHour++).padStart(2, "0");
  const row = await addBooking(
    w.db,
    { ...w, staffId },
    local(`2026-11-24T${hour}:30`),
    local(`2026-11-24T${hour}:45`),
    { source },
  );
  await w.db.insert(bookingService).values({
    bookingId: row.id,
    name: "Maintenance Haircut",
    durationMin: 45,
    priceCents: 9500,
  });
  return row.id;
}

beforeEach(async () => {
  w = await createWorld();
  sender = new FakeSender();
  nextHour = 9;
  log.mockClear();
  alexId = (await addStaff(w.db, w.businessId, "Alex")).id;
  await registerDevice(w.db, w.staffId, OWNER_TOKEN);
  await registerDevice(w.db, alexId, ALEX_TOKEN);
});
afterEach(async () => {
  await w.t.client.close();
});

describe("device registration", () => {
  test("registering twice keeps one row; the phone moves to whoever signed in last", async () => {
    await registerDevice(w.db, w.staffId, OWNER_TOKEN);
    expect(await w.db.select().from(deviceToken)).toHaveLength(2);
    await registerDevice(w.db, alexId, OWNER_TOKEN);
    const row = (
      await w.db.select().from(deviceToken).where(eq(deviceToken.token, OWNER_TOKEN))
    )[0];
    expect(row.staffId).toBe(alexId);
    expect(await tokensFor(w.db, [w.staffId])).toEqual([]);
  });

  test("a malformed token is refused", async () => {
    await expect(registerDevice(w.db, w.staffId, "not-a-token")).rejects.toThrow(
      "valid push token",
    );
  });

  test("only the current owner of a phone can unregister it", async () => {
    await unregisterDevice(w.db, w.staffId, ALEX_TOKEN);
    expect(await tokensFor(w.db, [alexId])).toEqual([ALEX_TOKEN]);
    await unregisterDevice(w.db, alexId, ALEX_TOKEN);
    expect(await tokensFor(w.db, [alexId])).toEqual([]);
  });

  test("tokens of inactive staff are never used; dead tokens are removed", async () => {
    await w.db.update(staff).set({ active: false }).where(eq(staff.id, alexId));
    expect(await tokensFor(w.db, [w.staffId, alexId])).toEqual([OWNER_TOKEN]);
    await removeDeadTokens(w.db, [OWNER_TOKEN]);
    await removeDeadTokens(w.db, []);
    expect(await w.db.select().from(deviceToken)).toHaveLength(1);
  });

  test("the owners are found", async () => {
    expect(await ownerIds(w.db)).toEqual([w.staffId]);
  });
});

describe("a new booking made by a client", () => {
  test("notifies the stylist and the owner, with the first name only", async () => {
    await w.db
      .update(client)
      .set({ lastName: "Secretname", phone: "+61400000000" })
      .where(eq(client.id, w.clientId));
    const id = await bookingFor(alexId);
    expect(await run({ type: "booking.confirmed", bookingId: id })).toBe(2);

    expect(sender.sent.map((m) => m.to).sort()).toEqual([ALEX_TOKEN, OWNER_TOKEN].sort());
    const m = sender.sent[0];
    expect(m.title).toBe("New booking");
    expect(m.body).toContain("Sam");
    expect(m.body).toContain("Maintenance Haircut");
    expect(m.body).toContain("9:30");
    expect(JSON.stringify(m)).not.toMatch(/Secretname|61400000000|sam@example/);
    expect(m.data).toEqual({ bookingId: id, kind: "new" });
  });

  test("someone who is both the stylist and the owner hears once", async () => {
    const id = await bookingFor(w.staffId);
    expect(await run({ type: "booking.confirmed", bookingId: id })).toBe(1);
    expect(sender.sent).toHaveLength(1);
  });

  test("a booking staff made themselves, or an import, is not news", async () => {
    expect(
      await run({ type: "booking.confirmed", bookingId: await bookingFor(alexId, "admin") }),
    ).toBe(0);
    expect(
      await run({
        type: "booking.confirmed",
        bookingId: await bookingFor(alexId, "import:timely"),
      }),
    ).toBe(0);
    expect(sender.sent).toHaveLength(0);
  });

  test("the staff-alerts switch in settings turns push off too", async () => {
    await w.db
      .update(business)
      .set({ settings: { staffAlertsEnabled: false } })
      .where(eq(business.id, w.businessId));
    expect(await run({ type: "booking.confirmed", bookingId: await bookingFor(alexId) })).toBe(0);
  });

  test("nobody registered means nothing is sent", async () => {
    await w.db.delete(deviceToken);
    expect(await run({ type: "booking.confirmed", bookingId: await bookingFor(alexId) })).toBe(0);
    expect(sender.sent).toHaveLength(0);
  });

  test("a booking that no longer exists is ignored", async () => {
    expect(
      await run({ type: "booking.confirmed", bookingId: "00000000-0000-4000-8000-000000000000" }),
    ).toBe(0);
  });
});

describe("a cancellation", () => {
  test("by the client tells the stylist and owner", async () => {
    const id = await bookingFor(alexId);
    expect(
      await run({
        type: "booking.cancelled",
        bookingId: id,
        by: "client",
        depositAction: "refund",
        feeCents: 0,
      }),
    ).toBe(2);
    expect(sender.sent[0].title).toBe("Booking cancelled");
    expect(sender.sent[0].data).toMatchObject({ kind: "cancelled" });
  });

  test("by staff does not notify anyone", async () => {
    const id = await bookingFor(alexId);
    expect(
      await run({
        type: "booking.cancelled",
        bookingId: id,
        by: "staff",
        depositAction: "refund",
        feeCents: 0,
      }),
    ).toBe(0);
  });
});

describe("delivery problems", () => {
  test("a token Expo says is gone is removed, and not counted as sent", async () => {
    sender.tickets = [
      { status: "error", message: "gone", error: "DeviceNotRegistered" },
      { status: "ok" },
    ];
    const id = await bookingFor(alexId);
    expect(await run({ type: "booking.confirmed", bookingId: id })).toBe(1);
    expect(await w.db.select().from(deviceToken)).toHaveLength(1);
  });

  test("other errors are logged and counted, but the phone is kept", async () => {
    sender.tickets = [
      { status: "error", message: "rate limited", error: "MessageRateExceeded" },
      { status: "error", message: "rate limited", error: "MessageRateExceeded" },
    ];
    expect(await run({ type: "booking.confirmed", bookingId: await bookingFor(alexId) })).toBe(0);
    expect(await w.db.select().from(deviceToken)).toHaveLength(2);
    expect(log).toHaveBeenCalledWith(expect.objectContaining({ event: "push_failed", count: 2 }));
  });

  test("if Expo cannot be reached the error surfaces so the job is retried", async () => {
    sender.send = async () => {
      throw new Error("Expo push service replied 503");
    };
    await expect(
      run({ type: "booking.confirmed", bookingId: await bookingFor(alexId) }),
    ).rejects.toThrow("503");
  });
});

describe("other events", () => {
  test.each([
    [{ type: "payment.succeeded", paymentId: "p" }],
    [{ type: "booking.completed", bookingId: "b" }],
    [{ type: "booking.confirmed" }],
    [{ type: "booking.cancelled", bookingId: "b" }],
    [{}],
  ])("%j is ignored", async (event) => {
    expect(await run(event as Record<string, unknown>)).toBe(0);
    expect(sender.sent).toHaveLength(0);
  });
});
