import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { desc, eq } from "drizzle-orm";
import { auditLog, booking, client, payment, service, staff, timeBlock } from "@/db/schema";
import { createRateLimiter } from "@/server/mcp/rate-limit";
import { createHarness, type Harness } from "./harness";

let h: Harness;
let call: Awaited<ReturnType<Harness["connect"]>>["call"];
let close: () => Promise<void>;

beforeAll(async () => {
  h = await createHarness();
  const c = await h.connect();
  call = c.call;
  close = c.close;
});
afterAll(async () => {
  await close();
  await h.close();
});
beforeEach(() => {
  h.clock.now = new Date("2026-11-14T01:00:00Z");
  for (const fn of Object.values(h.services)) fn.mockClear();
});

/** Preview, then confirm with the returned token. */
async function twoStep(name: string, args: Record<string, unknown>) {
  const preview = await call(name, args);
  expect(preview.isError, preview.raw).toBe(false);
  expect(preview.body.status).toBe("confirmation_required");
  const executed = await call(name, { ...args, confirmToken: preview.body.confirmToken });
  return { preview, executed };
}

const lastAudit = async (action: string) => {
  const rows = await h.t.db
    .select()
    .from(auditLog)
    .where(eq(auditLog.action, action))
    .orderBy(desc(auditLog.at));
  return rows[0];
};

/** A confirmed booking of its own, so tests never depend on each other's changes. */
async function liveBooking(
  startUtc: string,
  opts: { clientId?: string; depositPaid?: boolean } = {},
) {
  const start = new Date(startUtc);
  const [row] = await h.t.db
    .insert(booking)
    .values({
      staffId: h.fx.staffId,
      locationId: h.fx.northside,
      clientId: opts.clientId ?? h.fx.clients.jo,
      status: "confirmed",
      during: { start, end: new Date(start.getTime() + 45 * 60_000) },
      totalCents: 9500,
      depositCents: 4750,
    })
    .returning({ id: booking.id });
  if (opts.depositPaid) {
    await h.t.db.insert(payment).values({
      bookingId: row.id,
      kind: "deposit",
      method: "stripe_online",
      status: "succeeded",
      amountCents: 4750,
    });
  }
  return row.id;
}

const noWrites = () => {
  for (const [name, fn] of Object.entries(h.services)) {
    if (name !== "getAvailableSlots") expect(fn, name).not.toHaveBeenCalled();
  }
};

describe("confirm flow (all write tools)", () => {
  const args = () => ({ clientId: h.fx.clients.sam, note: "Prefers a number 2 on the sides" });

  test("the first call previews and changes nothing", async () => {
    const before = (await h.t.db.select().from(client).where(eq(client.id, h.fx.clients.sam)))[0]
      .notes;
    const r = await call("add_client_note", args());
    expect(r.body).toMatchObject({
      status: "confirmation_required",
      tool: "add_client_note",
      nothingChangedYet: true,
    });
    expect(r.body.confirmToken).toMatch(/^v1\.\d+\.[\w-]+\.[\w-]+$/);
    expect(r.body.expiresAt).toBe("2026-11-14T01:05:00.000Z");
    expect(r.body.preview.summary).toContain("Sam Client");
    const after = (await h.t.db.select().from(client).where(eq(client.id, h.fx.clients.sam)))[0]
      .notes;
    expect(after).toBe(before);
  });

  test("a token only works for exactly the arguments it was issued for", async () => {
    const preview = await call("add_client_note", args());
    const tampered = await call("add_client_note", {
      ...args(),
      note: "Prefers a number 2 on the sides!",
      confirmToken: preview.body.confirmToken,
    });
    expect(tampered.body.error.code).toBe("confirm_token_invalid");
    const otherClient = await call("add_client_note", {
      ...args(),
      clientId: h.fx.clients.jo,
      confirmToken: preview.body.confirmToken,
    });
    expect(otherClient.body.error.code).toBe("confirm_token_invalid");
    const notes = (await h.t.db.select().from(client).where(eq(client.id, h.fx.clients.sam)))[0]
      .notes;
    expect(notes ?? "").not.toContain("number 2");
  });

  test("a token for one tool is useless on another", async () => {
    const preview = await call("add_client_note", args());
    const r = await call("send_message", {
      clientId: h.fx.clients.sam,
      channel: "sms",
      body: "Prefers a number 2 on the sides",
      confirmToken: preview.body.confirmToken,
    });
    expect(r.body.error.code).toBe("confirm_token_invalid");
    noWrites();
  });

  test("tokens expire after five minutes", async () => {
    const preview = await call("add_client_note", args());
    h.clock.now = new Date("2026-11-14T01:05:01Z");
    const r = await call("add_client_note", { ...args(), confirmToken: preview.body.confirmToken });
    expect(r.body.error.code).toBe("confirm_token_expired");
  });

  test("a token works once; a replay does nothing", async () => {
    const { executed, preview } = await twoStep("add_client_note", {
      clientId: h.fx.clients.jo,
      note: "Once only",
    });
    expect(executed.body.status).toBe("executed");
    const replay = await call("add_client_note", {
      clientId: h.fx.clients.jo,
      note: "Once only",
      confirmToken: preview.body.confirmToken,
    });
    expect(replay.body.error.code).toBe("confirm_token_used");
    const notes = (await h.t.db.select().from(client).where(eq(client.id, h.fx.clients.jo)))[0]
      .notes;
    expect(notes?.match(/Once only/g)).toHaveLength(1);
  });

  test("garbage tokens are rejected as invalid or malformed input", async () => {
    for (const confirmToken of ["x", "v1.1.2.3", `v1.${"9".repeat(30)}.a.b`, "v2.1.a.b"]) {
      const r = await call("add_client_note", { ...args(), confirmToken });
      expect(r.isError, confirmToken).toBe(true);
      expect(["confirm_token_invalid", "invalid_input"]).toContain(r.body.error.code);
    }
  });

  test("every executed write is audited with actor mcp and no token or message text", async () => {
    await twoStep("add_client_note", { clientId: h.fx.clients.alex, note: "Audit me" });
    const row = await lastAudit("mcp.add_client_note");
    expect(row).toMatchObject({ actor: "mcp", entityType: "client", entityId: h.fx.clients.alex });
    expect(JSON.stringify(row.data)).not.toMatch(/Audit me|v1\./);
    expect(row.data).toMatchObject({ noteLength: 8, ownerId: "owner-1" });
  });

  test("writes are rate limited per token", async () => {
    const tight = {
      writeLimiter: createRateLimiter({ limit: 2, windowMs: 60_000, now: () => h.clock.now }),
    };
    const c = await h.connect({ deps: tight });
    const a = { clientId: h.fx.clients.sam, note: "x" };
    expect((await c.call("add_client_note", a)).isError).toBe(false);
    expect((await c.call("add_client_note", a)).isError).toBe(false);
    const third = await c.call("add_client_note", a);
    expect(third.body.error).toMatchObject({
      code: "rate_limited",
      details: { retryAfterSeconds: expect.any(Number) },
    });
    // Another token has its own allowance, and reads are not limited.
    const other = await h.connect({
      deps: tight,
      principal: { actor: "mcp", ownerId: "owner-1", tokenId: "tok2" },
    });
    expect((await other.call("add_client_note", a)).isError).toBe(false);
    expect((await c.call("list_services", {})).isError).toBe(false);
    await c.close();
    await other.close();
  });
});

describe("create_booking", () => {
  const start = "2026-11-24T14:00"; // local time, no offset
  const base = () => ({ locationId: h.fx.northside, serviceIds: [h.fx.cutId], start });

  test("previews, then creates and confirms through the booking engine", async () => {
    h.setSlots([
      {
        staffId: h.fx.staffId,
        start: new Date("2026-11-24T03:00:00Z"),
        end: new Date("2026-11-24T03:45:00Z"),
      },
    ]);
    const args = {
      ...base(),
      client: {
        firstName: "Casey",
        lastName: "Lee",
        email: "casey@example.com",
        phone: "0412 345 678",
      },
    };
    const { preview, executed } = await twoStep("create_booking", args);
    expect(preview.body.preview.summary).toContain('"Casey Lee" (NEW client)');
    expect(preview.body.preview.summary).toContain("Tue 24 Nov 2026, 2:00 pm");
    expect(preview.body.preview.details).toMatchObject({
      availabilityCheck: "available",
      estimatedTotalCents: 9500,
      depositCollected: false,
    });

    expect(executed.body.status, executed.raw).toBe("executed");
    const hold = h.services.createHold.mock.calls[0][1];
    expect(hold).toMatchObject({
      locationId: h.fx.northside,
      serviceIds: [h.fx.cutId],
      policyVersion: "1",
      source: "mcp",
      client: { firstName: "Casey", email: "casey@example.com", phone: "+61412345678" },
    });
    expect(hold.start.toISOString()).toBe("2026-11-24T03:00:00.000Z");
    expect(h.services.confirmBooking).toHaveBeenCalledTimes(1);
    const bookingId = executed.body.result.bookingId;
    const [row] = await h.t.db.select().from(booking).where(eq(booking.id, bookingId));
    expect(row.status).toBe("confirmed");
    expect((await lastAudit("mcp.create_booking")).entityId).toBe(bookingId);
  });

  test("books an existing client from their stored details", async () => {
    const { executed } = await twoStep("create_booking", {
      ...base(),
      start: "2026-11-25T11:00:00+11:00",
      clientId: h.fx.clients.sam,
    });
    expect(executed.body.status).toBe("executed");
    expect(h.services.createHold.mock.calls[0][1].client).toMatchObject({
      email: "sam@example.com",
      phone: "+61410123456",
    });
  });

  test("warns when the time is not an open slot or cannot be checked", async () => {
    h.setSlots([]);
    const p1 = await call("create_booking", { ...base(), clientId: h.fx.clients.sam });
    expect(p1.body.preview.details.availabilityCheck).toBe("not_offered");
    expect(p1.body.preview.summary).toMatch(/Warning/);
    h.services.getAvailableSlots.mockRejectedValueOnce(
      new Error("getAvailableSlots not implemented"),
    );
    const p2 = await call("create_booking", { ...base(), clientId: h.fx.clients.sam });
    expect(p2.body.preview.details.availabilityCheck).toBe("unverified");
  });

  test("validates who is being booked, the phone, the time and the services", async () => {
    const neither = await call("create_booking", base());
    expect(neither.body.error.code).toBe("invalid_input");
    const both = await call("create_booking", {
      ...base(),
      clientId: h.fx.clients.sam,
      client: { firstName: "A", email: "a@example.com", phone: "0412345678" },
    });
    expect(both.body.error.code).toBe("invalid_input");
    const badPhone = await call("create_booking", {
      ...base(),
      client: { firstName: "A", email: "a@example.com", phone: "123456" },
    });
    expect(badPhone.body.error.message).toMatch(/phone/i);
    const badEmail = await call("create_booking", {
      ...base(),
      client: { firstName: "A", email: "nope", phone: "0412345678" },
    });
    expect(badEmail.body.error.code).toBe("invalid_input");
    const past = await call("create_booking", {
      ...base(),
      start: "2026-11-01T10:00",
      clientId: h.fx.clients.sam,
    });
    expect(past.body.error.message).toMatch(/future/);
    const garbage = await call("create_booking", {
      ...base(),
      start: "next tuesday-ish",
      clientId: h.fx.clients.sam,
    });
    expect(garbage.body.error.code).toBe("invalid_input");
    const unknownService = await call("create_booking", {
      ...base(),
      serviceIds: ["00000000-0000-4000-8000-000000000000"],
      clientId: h.fx.clients.sam,
    });
    expect(unknownService.body.error.code).toBe("not_found");
    const unknownLocation = await call("create_booking", {
      ...base(),
      locationId: "00000000-0000-4000-8000-000000000000",
      clientId: h.fx.clients.sam,
    });
    expect(unknownLocation.body.error.code).toBe("not_found");
    noWrites();
  });

  test("refuses blocked, merged and contactless clients", async () => {
    const [blocked] = await h.t.db
      .insert(client)
      .values({
        firstName: "Bo",
        lastName: "Locked",
        email: "bo@example.com",
        phone: "+61400000001",
        blocked: true,
      })
      .returning();
    const [merged] = await h.t.db
      .insert(client)
      .values({
        firstName: "Mo",
        lastName: "Merged",
        email: "mo@example.com",
        phone: "+61400000002",
        mergedIntoId: h.fx.clients.sam,
      })
      .returning();
    const [noContact] = await h.t.db
      .insert(client)
      .values({ firstName: "No", lastName: "Contact" })
      .returning();
    for (const [id, pattern] of [
      [blocked.id, /blocked/],
      [merged.id, /merged/],
      [noContact.id, /no email or no phone/],
    ] as const) {
      const r = await call("create_booking", { ...base(), clientId: id });
      expect(r.isError).toBe(true);
      expect(r.body.error.message).toMatch(pattern);
    }
  });

  test("if confirming fails after the hold, says so and returns the booking id", async () => {
    h.services.confirmBooking.mockRejectedValueOnce(new Error("boom"));
    const { executed } = await twoStep("create_booking", {
      ...base(),
      start: "2026-11-26T10:00",
      clientId: h.fx.clients.sam,
    });
    expect(executed.body.error).toMatchObject({
      code: "backend_error",
      details: { bookingId: expect.any(String) },
    });
    expect((await lastAudit("mcp.create_booking.failed")).data).toMatchObject({
      code: "backend_error",
    });
  });

  test("domain errors surface as backend_error; unfinished domain code as backend_unavailable", async () => {
    h.services.createHold.mockRejectedValueOnce(new Error("That time is no longer available"));
    const slotTaken = await twoStep("create_booking", {
      ...base(),
      start: "2026-11-27T10:00",
      clientId: h.fx.clients.sam,
    });
    expect(slotTaken.executed.body.error).toMatchObject({
      code: "backend_error",
      message: "That time is no longer available",
    });
    h.services.createHold.mockRejectedValueOnce(new Error("createHold not implemented"));
    const stub = await twoStep("create_booking", {
      ...base(),
      start: "2026-11-28T10:00",
      clientId: h.fx.clients.sam,
    });
    expect(stub.executed.body.error.code).toBe("backend_unavailable");
    h.services.createHold.mockRejectedValueOnce(
      new Error('insert into "booking" violates a constraint\nsecret detail'),
    );
    const raw = await twoStep("create_booking", {
      ...base(),
      start: "2026-11-29T10:00",
      clientId: h.fx.clients.sam,
    });
    expect(raw.executed.body.error.message).not.toContain("secret detail");
  });
});

describe("move_booking", () => {
  const move = (bookingId: string, extra: Record<string, unknown> = {}) => ({
    bookingId,
    newStart: "2026-11-21T09:00",
    ...extra,
  });

  test("previews the change and reschedules as staff, notifying by default", async () => {
    const id = await liveBooking("2026-11-20T06:00:00Z"); // Fri 20 Nov 17:00 local
    const { preview, executed } = await twoStep("move_booking", move(id));
    expect(preview.body.preview.summary).toContain(
      "from Fri 20 Nov 2026, 5:00 pm to Sat 21 Nov 2026, 9:00 am",
    );
    expect(preview.body.preview.summary).toContain("will be notified");
    expect(executed.body.status).toBe("executed");
    const input = h.services.rescheduleBooking.mock.calls[0][1];
    expect(input).toMatchObject({ bookingId: id, by: "staff", notifyClient: true });
    expect(input.newStart.toISOString()).toBe("2026-11-20T22:00:00.000Z");
    expect((await lastAudit("mcp.move_booking")).entityId).toBe(id);
  });

  test("can move quietly", async () => {
    const id = await liveBooking("2026-11-27T04:00:00Z");
    const { preview } = await twoStep(
      "move_booking",
      move(id, { newStart: "2026-11-28T09:00", notifyClient: false }),
    );
    expect(preview.body.preview.summary).toContain("will NOT be notified");
    expect(h.services.rescheduleBooking.mock.calls[0][1].notifyClient).toBe(false);
  });

  test("only moves live future bookings to a different future time", async () => {
    const id = await liveBooking("2026-12-04T04:00:00Z"); // 15:00 local
    const completed = await call("move_booking", move(h.fx.bookings.b1));
    expect(completed.body.error.code).toBe("precondition_failed");
    const past = await call("move_booking", move(id, { newStart: "2026-11-01T09:00" }));
    expect(past.body.error.message).toMatch(/future/);
    const same = await call("move_booking", move(id, { newStart: "2026-12-04T15:00" }));
    expect(same.body.error.message).toMatch(/already at that time/);
    const missing = await call("move_booking", move("00000000-0000-4000-8000-000000000000"));
    expect(missing.body.error.code).toBe("not_found");
    noWrites();
  });
});

describe("cancel_booking", () => {
  test("previews the deposit outcome, then cancels as staff with a forced refund by default", async () => {
    const id = await liveBooking("2026-11-30T03:00:00Z");
    const { preview, executed } = await twoStep("cancel_booking", {
      bookingId: id,
      reason: "Client called",
    });
    expect(preview.body.preview.summary).toContain("CANCEL");
    expect(preview.body.preview.details).toMatchObject({
      depositOutcome: "refund",
      depositPaidCents: 0,
      insideCancelWindow: false,
    });
    expect(executed.body.result).toMatchObject({
      bookingId: id,
      status: "cancelled_by_staff",
      depositAction: "refund",
    });
    expect(h.services.cancelBooking.mock.calls[0][1]).toMatchObject({
      bookingId: id,
      by: "staff",
      forceRefund: true,
      reason: "Client called",
    });
    const audit = await lastAudit("mcp.cancel_booking");
    expect(audit.data).toMatchObject({ depositOutcome: "refund", hasReason: true });
  });

  test("policy mode explains the cancellation window", async () => {
    // Starts in 9 hours: inside the 24h window, so policy keeps the deposit.
    const soon = await liveBooking("2026-11-14T10:00:00Z", { depositPaid: true });
    const inside = await call("cancel_booking", { bookingId: soon, depositOutcome: "policy" });
    expect(inside.body.preview.summary).toContain("inside the 24h window");
    expect(inside.body.preview.summary).toContain("keeps the $47.50 deposit");
    expect(inside.body.preview.details.insideCancelWindow).toBe(true);
    // Days away: outside the window, policy refunds. Forcing a refund says so plainly.
    const later = await liveBooking("2026-12-10T03:00:00Z", { depositPaid: true });
    const outside = await call("cancel_booking", { bookingId: later, depositOutcome: "policy" });
    expect(outside.body.preview.summary).toContain(
      "outside the 24h window, so policy refunds the $47.50",
    );
    const refund = await call("cancel_booking", { bookingId: later });
    expect(refund.body.preview.summary).toContain("$47.50 deposit will be refunded");
  });

  test("a fee on the outcome points to the money tool", async () => {
    const id = await liveBooking("2026-12-11T03:00:00Z");
    h.services.cancelBooking.mockResolvedValueOnce({
      bookingId: id,
      status: "late_cancelled",
      depositAction: "keep",
      feeCents: 1900,
    });
    const { executed } = await twoStep("cancel_booking", {
      bookingId: id,
      depositOutcome: "policy",
    });
    expect(executed.body.result.feeNote).toMatch(/charge_no_show_fee/);
  });

  test("refuses bookings that are not live", async () => {
    const r = await call("cancel_booking", { bookingId: h.fx.bookings.b1 });
    expect(r.body.error.code).toBe("precondition_failed");
    noWrites();
  });
});

describe("block_time", () => {
  const block = (extra: Record<string, unknown> = {}) => ({
    start: "2026-12-01T09:00",
    end: "2026-12-01T13:00",
    reason: "Dentist",
    ...extra,
  });

  test("previews, then inserts a manual time block", async () => {
    const { preview, executed } = await twoStep("block_time", block());
    expect(preview.body.preview.summary).toContain("Block Ryan's time");
    expect(preview.body.preview.summary).toContain("No existing bookings");
    const [row] = await h.t.db
      .select()
      .from(timeBlock)
      .where(eq(timeBlock.id, executed.body.result.timeBlockId));
    expect(row).toMatchObject({ source: "manual", reason: "Dentist", staffId: h.fx.staffId });
    expect(row.during.start.toISOString()).toBe("2026-11-30T22:00:00.000Z");
    expect((await lastAudit("mcp.block_time")).entityId).toBe(row.id);
  });

  test("warns about, but does not touch, bookings inside the window", async () => {
    await liveBooking("2026-12-15T04:00:00Z"); // 15:00 local
    const r = await call(
      "block_time",
      block({ start: "2026-12-15T14:00", end: "2026-12-15T16:00" }),
    );
    expect(r.body.preview.summary).toMatch(/1 existing booking/);
    expect(r.body.preview.details.clashingBookings).toHaveLength(1);
  });

  test("validates the window and the stylist", async () => {
    expect(
      (await call("block_time", block({ end: "2026-12-01T08:00" }))).body.error.message,
    ).toMatch(/after start/);
    expect(
      (await call("block_time", block({ end: "2027-03-01T08:00" }))).body.error.message,
    ).toMatch(/31 days/);
    expect(
      (await call("block_time", block({ staffId: "00000000-0000-4000-8000-000000000000" }))).body
        .error.code,
    ).toBe("not_found");
    await h.t.db.insert(staff).values({ name: "Second Stylist" });
    const ambiguous = await call("block_time", block());
    expect(ambiguous.body.error).toMatchObject({
      code: "invalid_input",
      details: { stylists: expect.any(Array) },
    });
    expect((await call("block_time", block({ staffId: h.fx.staffId }))).isError).toBe(false);
  });
});

describe("update_service", () => {
  test("previews exact before/after, then updates only what changed", async () => {
    const { preview, executed } = await twoStep("update_service", {
      serviceId: h.fx.beardId,
      priceCents: 3500,
      active: false,
    });
    expect(preview.body.preview.summary).toContain("priceCents $30.00 -> $35.00");
    expect(preview.body.preview.summary).toContain("active true -> false");
    expect(executed.body.result.changes).toHaveLength(2);
    const [row] = await h.t.db.select().from(service).where(eq(service.id, h.fx.beardId));
    expect(row).toMatchObject({ priceCents: 3500, active: false, name: "Beard" });
    expect((await lastAudit("mcp.update_service")).data).toMatchObject({
      priceCents: 3500,
      active: false,
    });
  });

  test("clears an override with null, and rejects no-ops and out of range values", async () => {
    await h.t.db.update(service).set({ depositPct: 25 }).where(eq(service.id, h.fx.cutId));
    await twoStep("update_service", { serviceId: h.fx.cutId, depositPct: null });
    expect(
      (await h.t.db.select().from(service).where(eq(service.id, h.fx.cutId)))[0].depositPct,
    ).toBeNull();
    expect(
      (await call("update_service", { serviceId: h.fx.cutId, name: "Cut" })).body.error.message,
    ).toMatch(/not change anything/);
    expect((await call("update_service", { serviceId: h.fx.cutId })).body.error.code).toBe(
      "invalid_input",
    );
    expect(
      (await call("update_service", { serviceId: h.fx.cutId, priceCents: -5 })).body.error.code,
    ).toBe("invalid_input");
    expect(
      (await call("update_service", { serviceId: h.fx.cutId, depositPct: 150 })).body.error.code,
    ).toBe("invalid_input");
    expect(
      (
        await call("update_service", {
          serviceId: "00000000-0000-4000-8000-000000000000",
          name: "x",
        })
      ).body.error.code,
    ).toBe("not_found");
  });

  test("a stale confirmation that no longer changes anything is refused at execute time", async () => {
    const args = { serviceId: h.fx.cutId, bufferMin: 10 };
    const preview = await call("update_service", args);
    await h.t.db.update(service).set({ bufferMin: 10 }).where(eq(service.id, h.fx.cutId));
    const r = await call("update_service", { ...args, confirmToken: preview.body.confirmToken });
    expect(r.body.error.code).toBe("invalid_input");
  });
});

describe("add_client_note", () => {
  test("appends dated notes without losing earlier ones", async () => {
    await twoStep("add_client_note", { clientId: h.fx.clients.pat, note: "Allergic to ammonia" });
    await twoStep("add_client_note", { clientId: h.fx.clients.pat, note: "Likes quiet" });
    const notes = (await h.t.db.select().from(client).where(eq(client.id, h.fx.clients.pat)))[0]
      .notes!;
    expect(notes.split("\n")).toEqual([
      "[Sat 14 Nov 2026, 12:00 pm via Claude] Allergic to ammonia",
      "[Sat 14 Nov 2026, 12:00 pm via Claude] Likes quiet",
    ]);
  });

  test("validates the note and the client", async () => {
    expect(
      (await call("add_client_note", { clientId: h.fx.clients.pat, note: "   " })).body.error.code,
    ).toBe("invalid_input");
    expect(
      (await call("add_client_note", { clientId: h.fx.clients.pat, note: "x".repeat(1001) })).body
        .error.code,
    ).toBe("invalid_input");
    expect(
      (
        await call("add_client_note", {
          clientId: "00000000-0000-4000-8000-000000000000",
          note: "x",
        })
      ).body.error.code,
    ).toBe("not_found");
    const [merged] = await h.t.db
      .insert(client)
      .values({ firstName: "M", mergedIntoId: h.fx.clients.sam })
      .returning();
    expect(
      (await call("add_client_note", { clientId: merged.id, note: "x" })).body.error.code,
    ).toBe("precondition_failed");
  });
});

describe("send_message", () => {
  test("shows the exact recipient and wording, sends only after confirmation", async () => {
    const args = {
      clientId: h.fx.clients.sam,
      channel: "sms",
      body: "Running 10 minutes late, see you soon",
    };
    const preview = await call("send_message", args);
    expect(h.services.sendOneOffMessage).not.toHaveBeenCalled();
    expect(preview.body.preview.summary).toContain('SMS to "Sam Client" at "+61410123456"');
    expect(preview.body.preview.summary).toContain("Running 10 minutes late");
    expect(preview.body.preview.details).toMatchObject({
      clientHasMarketingConsent: false,
      channel: "sms",
    });
    const executed = await call("send_message", {
      ...args,
      confirmToken: preview.body.confirmToken,
    });
    expect(executed.body.status).toBe("executed");
    expect(h.services.sendOneOffMessage).toHaveBeenCalledWith(h.t.db, {
      clientId: h.fx.clients.sam,
      channel: "sms",
      subject: undefined,
      body: "Running 10 minutes late, see you soon",
    });
    expect((await lastAudit("mcp.send_message")).data).toMatchObject({
      channel: "sms",
      bodyLength: 37,
    });
  });

  test("email carries a subject", async () => {
    const { preview } = await twoStep("send_message", {
      clientId: h.fx.clients.sam,
      channel: "email",
      subject: "Your appointment",
      body: "Hi Sam",
    });
    expect(preview.body.preview.summary).toContain('with subject "Your appointment"');
    expect(h.services.sendOneOffMessage.mock.calls[0][1]).toMatchObject({
      subject: "Your appointment",
      channel: "email",
    });
  });

  test("rejects missing contact details, over-long SMS and a subject on SMS", async () => {
    expect(
      (await call("send_message", { clientId: h.fx.clients.jo, channel: "sms", body: "hi" })).body
        .error.code,
    ).toBe("precondition_failed");
    expect(
      (
        await call("send_message", {
          clientId: h.fx.clients.sam,
          channel: "sms",
          body: "x".repeat(481),
        })
      ).body.error.code,
    ).toBe("invalid_input");
    expect(
      (
        await call("send_message", {
          clientId: h.fx.clients.sam,
          channel: "sms",
          subject: "s",
          body: "hi",
        })
      ).body.error.code,
    ).toBe("invalid_input");
    expect(
      (await call("send_message", { clientId: h.fx.clients.sam, channel: "fax", body: "hi" })).body
        .error.code,
    ).toBe("invalid_input");
    const [merged] = await h.t.db
      .insert(client)
      .values({ firstName: "M", email: "m@example.com", mergedIntoId: h.fx.clients.sam })
      .returning();
    expect(
      (await call("send_message", { clientId: merged.id, channel: "email", body: "hi" })).body.error
        .code,
    ).toBe("precondition_failed");
    noWrites();
  });
});
