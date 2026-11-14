import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { eq } from "drizzle-orm";
import { booking, integrationAccount } from "@/db/schema";
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

describe("tool catalogue", () => {
  test("lists exactly the planned tools with schemas and the right hints", async () => {
    const c = await h.connect();
    const { tools } = await c.client.listTools();
    expect(tools.map((t) => t.name)).toEqual([
      "list_bookings",
      "get_booking",
      "find_client",
      "get_client_history",
      "check_availability",
      "get_revenue_summary",
      "get_cancellation_report",
      "list_services",
      "get_integration_status",
      "create_booking",
      "move_booking",
      "cancel_booking",
      "block_time",
      "update_service",
      "add_client_note",
      "send_message",
      "refund_payment",
      "charge_no_show_fee",
    ]);
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    expect(byName.list_bookings.annotations?.readOnlyHint).toBe(true);
    expect(byName.cancel_booking.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
    });
    expect(byName.add_client_note.annotations?.destructiveHint).toBe(false);
    // Write tools advertise the confirm token; read tools do not.
    expect(byName.cancel_booking.inputSchema.properties).toHaveProperty("confirmToken");
    expect(byName.get_booking.inputSchema.properties).not.toHaveProperty("confirmToken");
    expect(byName.create_booking.description).toMatch(/preview/i);
    await c.close();
  });
});

describe("list_bookings", () => {
  test("lists a date range oldest first with services and wrapped client names", async () => {
    const r = await call("list_bookings", { from: "2026-11-01", to: "2026-11-30" });
    expect(r.isError).toBe(false);
    expect(r.body.count).toBe(8);
    const first = r.body.bookings[0];
    expect(first).toMatchObject({
      bookingId: h.fx.bookings.b1,
      status: "completed",
      services: ["Cut"],
      totalCents: 9500,
      location: { name: "Northside" },
      start: { local: "Tue 3 Nov 2026, 10:00 am" },
    });
    expect(first.client.name).toEqual({ untrusted: true, text: "Sam Client" });
    expect(r.body.dataNotice).toMatch(/untrusted/);
    const b2 = r.body.bookings.find((b: { bookingId: string }) => b.bookingId === h.fx.bookings.b2);
    expect(b2.services).toEqual(["Cut", "Beard"]);
  });

  test("filters by status and location, and pages with limit", async () => {
    const noShows = await call("list_bookings", {
      from: "2026-11-01",
      to: "2026-11-30",
      status: ["no_show"],
    });
    expect(noShows.body.bookings.map((b: { bookingId: string }) => b.bookingId)).toEqual([
      h.fx.bookings.b4,
    ]);
    const south = await call("list_bookings", {
      from: "2026-11-01",
      to: "2026-11-30",
      locationId: h.fx.southside,
    });
    expect(south.body.count).toBe(1);
    const limited = await call("list_bookings", { from: "2026-11-01", to: "2026-11-30", limit: 3 });
    expect(limited.body).toMatchObject({ count: 3, hasMore: true });
  });

  test("defaults to the next week from today", async () => {
    const r = await call("list_bookings", {});
    expect(r.body.from).toBe("2026-11-14");
    expect(r.body.to).toBe("2026-11-20");
    expect(r.body.bookings.map((b: { bookingId: string }) => b.bookingId)).toContain(
      h.fx.bookings.b7,
    );
  });

  test("rejects bad input with structured errors", async () => {
    const bad = await call("list_bookings", { from: "tomorrow" });
    expect(bad.isError).toBe(true);
    expect(bad.body.error.code).toBe("invalid_input");
    expect(bad.body.error.details.issues[0].path).toBe("from");
    const reversed = await call("list_bookings", { from: "2026-11-10", to: "2026-11-01" });
    expect(reversed.body.error.code).toBe("invalid_input");
    const huge = await call("list_bookings", { from: "2026-01-01", to: "2026-12-31" });
    expect(huge.body.error.message).toMatch(/93 days/);
    const wrongType = await call("list_bookings", { limit: "ten" });
    expect(wrongType.body.error.code).toBe("invalid_input");
    const unknownStatus = await call("list_bookings", { status: ["nope"] });
    expect(unknownStatus.isError).toBe(true);
  });
});

describe("get_booking", () => {
  test("returns full detail with payments and wrapped free text", async () => {
    await h.t.db
      .update(booking)
      .set({ comments: "Please use the quiet room", cancelReason: null })
      .where(eq(booking.id, h.fx.bookings.b2));
    const r = await call("get_booking", { bookingId: h.fx.bookings.b2 });
    expect(r.isError).toBe(false);
    expect(r.body).toMatchObject({
      bookingId: h.fx.bookings.b2,
      status: "completed",
      totalCents: 12500,
      location: { name: "Southside" },
      clientComments: { untrusted: true, text: "Please use the quiet room" },
      cancelReason: null,
    });
    expect(r.body.services).toHaveLength(2);
    expect(r.body.payments.map((p: { kind: string }) => p.kind)).toEqual(["deposit", "balance"]);
    expect(r.body.client.email).toEqual({ untrusted: true, text: "alex@example.com" });
  });

  test("unknown id is a structured not_found; malformed id is invalid_input", async () => {
    const missing = await call("get_booking", {
      bookingId: "00000000-0000-4000-8000-000000000000",
    });
    expect(missing.body.error.code).toBe("not_found");
    const bad = await call("get_booking", { bookingId: "abc" });
    expect(bad.body.error.code).toBe("invalid_input");
  });
});

describe("find_client and get_client_history", () => {
  test("finds by partial name, email and phone (national format)", async () => {
    const byName = await call("find_client", { query: "alex" });
    expect(byName.body.clients.map((c: { clientId: string }) => c.clientId)).toEqual([
      h.fx.clients.alex,
    ]);
    const byEmail = await call("find_client", { query: "jo@example" });
    expect(byEmail.body.count).toBe(1);
    const byPhone = await call("find_client", { query: "0410 123 456" });
    expect(byPhone.body.clients[0].clientId).toBe(h.fx.clients.sam);
    const none = await call("find_client", { query: "zzzz" });
    expect(none.body.count).toBe(0);
  });

  test("LIKE wildcards in the query match nothing special", async () => {
    for (const query of ["%%", "__", "\\\\"]) {
      const r = await call("find_client", { query });
      expect(r.body.count).toBe(0);
    }
    const tooShort = await call("find_client", { query: "a" });
    expect(tooShort.body.error.code).toBe("invalid_input");
  });

  test("history summarises visits and lists bookings newest first", async () => {
    const r = await call("get_client_history", { clientId: h.fx.clients.alex });
    expect(r.body.client.name.text).toBe("Alex Brown");
    expect(r.body.summary).toMatchObject({ completed: 1, noShows: 1, lateCancels: 0, upcoming: 0 });
    const times = r.body.bookings.map((b: { start: { utc: string } }) => b.start.utc);
    expect([...times].sort().reverse()).toEqual(times);
    const jo = await call("get_client_history", { clientId: h.fx.clients.jo });
    expect(jo.body.summary).toMatchObject({ lateCancels: 1, upcoming: 1 });
    const missing = await call("get_client_history", {
      clientId: "00000000-0000-4000-8000-000000000000",
    });
    expect(missing.body.error.code).toBe("not_found");
  });
});

describe("check_availability", () => {
  test("groups slots by local day using the booking engine", async () => {
    h.setSlots([
      {
        staffId: h.fx.staffId,
        start: new Date("2026-11-16T22:00:00Z"),
        end: new Date("2026-11-16T22:45:00Z"),
      },
      {
        staffId: h.fx.staffId,
        start: new Date("2026-11-16T23:00:00Z"),
        end: new Date("2026-11-16T23:45:00Z"),
      },
      {
        staffId: h.fx.staffId,
        start: new Date("2026-11-17T01:00:00Z"),
        end: new Date("2026-11-17T01:45:00Z"),
      },
    ]);
    const r = await call("check_availability", {
      locationId: h.fx.northside,
      serviceIds: [h.fx.cutId],
      fromDate: "2026-11-17",
      toDate: "2026-11-17",
    });
    expect(r.isError).toBe(false);
    expect(r.body.totalSlots).toBe(3);
    // 22:00Z on the 16th is 09:00 on the 17th in Melbourne.
    expect(r.body.days).toEqual([
      {
        date: "2026-11-17",
        starts: [
          "Tue 17 Nov 2026, 9:00 am",
          "Tue 17 Nov 2026, 10:00 am",
          "Tue 17 Nov 2026, 12:00 pm",
        ],
      },
    ]);
    const lastCall = h.services.getAvailableSlots.mock.calls.at(-1)![1];
    expect(lastCall).toMatchObject({
      locationId: h.fx.northside,
      serviceIds: [h.fx.cutId],
      fromDate: "2026-11-17",
    });
  });

  test("limits the window and validates dates", async () => {
    const wide = await call("check_availability", {
      locationId: h.fx.northside,
      serviceIds: [h.fx.cutId],
      fromDate: "2026-11-01",
      toDate: "2026-12-31",
    });
    expect(wide.body.error.message).toMatch(/14 days/);
    const reversed = await call("check_availability", {
      locationId: h.fx.northside,
      serviceIds: [h.fx.cutId],
      fromDate: "2026-11-05",
      toDate: "2026-11-01",
    });
    expect(reversed.body.error.code).toBe("invalid_input");
    const noServices = await call("check_availability", {
      locationId: h.fx.northside,
      serviceIds: [],
      fromDate: "2026-11-05",
      toDate: "2026-11-05",
    });
    expect(noServices.body.error.code).toBe("invalid_input");
  });

  test("reports an unavailable backend as such rather than failing opaquely", async () => {
    h.services.getAvailableSlots.mockRejectedValueOnce(
      new Error("getAvailableSlots not implemented"),
    );
    const r = await call("check_availability", {
      locationId: h.fx.northside,
      serviceIds: [h.fx.cutId],
      fromDate: "2026-11-17",
      toDate: "2026-11-17",
    });
    expect(r.body.error.code).toBe("backend_unavailable");
  });
});

describe("reports as tools", () => {
  test("get_revenue_summary matches the report layer", async () => {
    const r = await call("get_revenue_summary", {
      from: "2026-11-01",
      to: "2026-11-30",
      granularity: "month",
    });
    expect(r.body.totals).toMatchObject({
      grossCents: 42900,
      refundsCents: 4750,
      netCents: 38150,
      feesKeptCents: 11400,
    });
    expect(r.body.totalsFormatted).toMatchObject({
      gross: "$429.00",
      net: "$381.50",
      feesKept: "$114.00",
    });
    const byLoc = await call("get_revenue_summary", {
      from: "2026-11-01",
      to: "2026-11-30",
      groupBy: "location",
    });
    expect(byLoc.body.rows.some((x: { groupName: string }) => x.groupName === "Southside")).toBe(
      true,
    );
  });

  test("get_revenue_summary defaults to month to date", async () => {
    const r = await call("get_revenue_summary", {});
    expect(r.body).toMatchObject({ from: "2026-11-01", to: "2026-11-14", granularity: "week" });
    const bad = await call("get_revenue_summary", { from: "2026-02-31", to: "2026-03-01" });
    expect(bad.body.error.code).toBe("invalid_input");
  });

  test("get_cancellation_report lists incidents with wrapped names and reasons", async () => {
    await h.t.db
      .update(booking)
      .set({ cancelReason: "Flu" })
      .where(eq(booking.id, h.fx.bookings.b5));
    const r = await call("get_cancellation_report", { from: "2026-11-01", to: "2026-11-30" });
    expect(r.body).toMatchObject({
      keptCents: 11400,
      keptFormatted: "$114.00",
      cancellationRatePct: 42.9,
    });
    expect(r.body.counts).toMatchObject({ late_cancelled: 1, no_show: 1, cancelled_by_client: 1 });
    expect(r.body.incidents[0].reason).toEqual({ untrusted: true, text: "Flu" });
    expect(r.body.incidents[0].client.name.untrusted).toBe(true);
    const totalsOnly = await call("get_cancellation_report", {
      from: "2026-11-01",
      to: "2026-11-30",
      limit: 0,
    });
    expect(totalsOnly.body.incidents).toEqual([]);
    expect(totalsOnly.body.incidentsTruncated).toBe(true);
  });
});

describe("list_services and get_integration_status", () => {
  test("lists services, hiding inactive ones by default", async () => {
    const r = await call("list_services", {});
    expect(r.body.services.map((s: { name: string }) => s.name).sort()).toEqual(["Beard", "Cut"]);
    expect(r.body.services.find((s: { name: string }) => s.name === "Cut")).toMatchObject({
      priceCents: 9500,
      durationMin: 45,
      active: true,
    });
  });

  test("integration status never exposes tokens and reports money tool state", async () => {
    const [biz] = await h.t.db.select().from((await import("@/db/schema")).business);
    await h.t.db.insert(integrationAccount).values({
      businessId: biz.id,
      provider: "xero",
      status: "error",
      encryptedTokens: "SECRET-CIPHERTEXT",
      lastError: "Token refresh failed",
    });
    const r = await call("get_integration_status", {});
    expect(r.raw).not.toContain("SECRET-CIPHERTEXT");
    const byProvider = Object.fromEntries(
      r.body.integrations.map((i: { provider: string }) => [i.provider, i]),
    );
    expect(byProvider.xero).toMatchObject({
      status: "error",
      lastError: { untrusted: true, text: "Token refresh failed" },
    });
    expect(byProvider.stripe.status).toBe("not_connected");
    expect(r.body.mcp).toMatchObject({
      moneyToolsEnabled: false,
      maxMoneyCentsPerCall: 20000,
      maxMoneyCentsPerDay: 50000,
      moneyRemainingTodayCents: 50000,
    });
  });
});

describe("unknown tools and malformed arguments", () => {
  test("an unknown tool is a structured error", async () => {
    const r = await call("drop_database", {});
    expect(r.isError).toBe(true);
    expect(r.body.error.code).toBe("unknown_tool");
  });
});
