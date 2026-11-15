import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { DateTime } from "luxon";
import { eq } from "drizzle-orm";
import { booking, payment } from "@/db/schema";
import type { AccessContext } from "@/server/admin/access";
import type { StaffRole } from "@/server/contracts";

interface Viewer {
  role: StaffRole;
  staffId: string | null;
  userId: string;
}
const pay = vi.hoisted(() => ({
  start: vi.fn(),
  status: vi.fn(),
  token: vi.fn(),
  location: vi.fn(),
}));
const state = vi.hoisted(() => ({
  viewer: null as null | { role: string; staffId: string | null; userId: string },
  db: null as unknown,
  domain: {} as Record<string, unknown>,
}));

const signedOut = () =>
  Object.assign(new Error("NEXT_REDIRECT"), { digest: "NEXT_REDIRECT;replace;/login" });

vi.mock("next/server", () => ({ connection: async () => undefined }));
vi.mock("@/server/payments/terminal", () => ({
  startInPersonPayment: (...a: unknown[]) => pay.start(...a),
  inPersonPaymentStatus: (...a: unknown[]) => pay.status(...a),
  createConnectionToken: (...a: unknown[]) => pay.token(...a),
  terminalLocationId: () => pay.location(),
}));
vi.mock("@/db/client", () => ({ getDb: () => state.db }));
vi.mock("@/server/auth", () => ({
  requireAccessSession: async () => {
    if (!state.viewer) throw signedOut();
    return { ...state.viewer, email: "viewer@example.com", name: "Viewer" };
  },
}));
vi.mock("@/server/admin/session", async () => {
  const { hasPermission, AccessDeniedError } = await import("@/server/auth/access-core");
  const { actorFor, viewerCaps } = await import("@/server/admin/access");
  function resolve(permissions: string[]) {
    if (!state.viewer) throw signedOut();
    const v = state.viewer as unknown as Viewer;
    if (!permissions.some((p) => hasPermission(v.role, p as never))) {
      throw new AccessDeniedError(permissions[0] as never);
    }
    const access: AccessContext = { role: v.role, staffId: v.staffId };
    return { access, actor: actorFor(v.userId, v.role) };
  }
  return {
    CALENDAR_PERMISSIONS: ["calendar.viewAll", "calendar.viewOwn"],
    getReadContext: async (...permissions: string[]) => {
      const { access, actor } = resolve(permissions);
      return { db: state.db, actor, access, caps: viewerCaps(access) };
    },
    getCommandContext: async (...permissions: string[]) => {
      const { access, actor } = resolve(permissions);
      return { db: state.db, actor, access, domain: state.domain };
    },
  };
});

import { GET as getCalendar } from "@/app/api/v1/calendar/route";
import { GET as listBookings, POST as createBooking } from "@/app/api/v1/bookings/route";
import { GET as getBooking } from "@/app/api/v1/bookings/[id]/route";
import { POST as cancel } from "@/app/api/v1/bookings/[id]/cancel/route";
import { POST as checkout } from "@/app/api/v1/bookings/[id]/checkout/route";
import { POST as noShow } from "@/app/api/v1/bookings/[id]/no-show/route";
import { POST as reassign } from "@/app/api/v1/bookings/[id]/reassign/route";
import { POST as reschedule } from "@/app/api/v1/bookings/[id]/reschedule/route";
import { GET as searchClients } from "@/app/api/v1/clients/route";
import { GET as getClient } from "@/app/api/v1/clients/[id]/route";
import { GET as getMe } from "@/app/api/v1/me/route";
import { DELETE as removeDevice, POST as addDevice } from "@/app/api/v1/devices/route";
import { deviceToken } from "@/db/schema";
import { GET as terminalConfig } from "@/app/api/v1/payments/terminal/route";
import { POST as connectionToken } from "@/app/api/v1/payments/terminal/connection-token/route";
import {
  GET as cardStatus,
  POST as cardStart,
} from "@/app/api/v1/bookings/[id]/card-payment/route";
import { PaymentError } from "@/server/payments/stripe";
import { GET as getResources } from "@/app/api/v1/resources/route";
import { GET as getAvailability } from "@/app/api/v1/availability/route";
import { addBooking, addStaff, createWorld, type World } from "../availability/setup";

let w: World;
let otherStaffId: string;
let mine: string; // booking of the owner (w.staffId)
let theirs: string; // booking of the second stylist

const ORIGIN = "http://localhost:3000";
const tomorrow = () => DateTime.now().plus({ days: 2 }).startOf("hour");
const iso = (d: DateTime) => d.toUTC().toISO()!;
const req = (path: string, body?: unknown) =>
  new Request(`${ORIGIN}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const as = (role: StaffRole, staffId: string | null = null) => {
  state.viewer = { role, staffId, userId: `u-${role}` };
};
const outcome = {
  bookingId: "x",
  status: "cancelled_by_staff",
  depositAction: "refund",
  feeCents: 0,
};

beforeEach(async () => {
  w = await createWorld();
  state.db = w.db;
  otherStaffId = (await addStaff(w.db, w.businessId, "Alex")).id;
  const start = tomorrow();
  mine = (await addBooking(w.db, w, start.toJSDate(), start.plus({ minutes: 45 }).toJSDate())).id;
  theirs = (
    await addBooking(
      w.db,
      { ...w, staffId: otherStaffId },
      start.toJSDate(),
      start.plus({ minutes: 45 }).toJSDate(),
    )
  ).id;
  state.viewer = null;
  state.domain = {
    createHold: vi.fn(async () => ({ bookingId: "11111111-1111-4111-8111-111111111111" })),
    confirmBooking: vi.fn(async () => undefined),
    cancelBooking: vi.fn(async () => outcome),
    rescheduleBooking: vi.fn(async () => undefined),
    markNoShow: vi.fn(async () => ({ ...outcome, status: "no_show", depositAction: "keep" })),
    recordManualPayment: vi.fn(async () => undefined),
    completeBooking: vi.fn(async () => undefined),
    reassignBooking: vi.fn(async () => undefined),
  };
});
afterEach(async () => {
  await w.t.client.close();
});

const json = async (res: Response) => res.json();

describe("signed out", () => {
  test.each([
    ["me", () => getMe()],
    ["calendar", () => getCalendar(req("/api/v1/calendar"))],
    ["bookings", () => listBookings(req("/api/v1/bookings"))],
    ["booking", () => getBooking(req("/x"), ctx(mine))],
    ["create", () => createBooking(req("/api/v1/bookings", {}))],
    ["cancel", () => cancel(req("/x", {}), ctx(mine))],
    ["clients", () => searchClients(req("/api/v1/clients"))],
  ])("%s is 401", async (_n, call) => {
    const res = await call();
    expect(res.status).toBe(401);
    expect((await json(res)).error.code).toBe("unauthenticated");
  });
});

describe("GET /me", () => {
  test("the owner gets everything, with the business", async () => {
    as("owner", w.staffId);
    const body = await json(await getMe());
    expect(body.data).toMatchObject({
      role: "owner",
      staffId: w.staffId,
      business: { name: "Test Business", timezone: "Australia/Melbourne" },
    });
    expect(body.data.permissions).toContain("data.import");
  });

  test("a stylist gets fewer permissions", async () => {
    as("stylist", otherStaffId);
    const { permissions } = (await json(await getMe())).data;
    expect(permissions).toContain("calendar.viewOwn");
    expect(permissions).not.toContain("staff.manage");
    expect(permissions).not.toContain("data.import");
  });
});

describe("reads", () => {
  test("the owner sees every booking; a stylist only their own", async () => {
    as("owner", w.staffId);
    expect((await json(await listBookings(req("/api/v1/bookings")))).data.bookings).toHaveLength(2);
    as("stylist", otherStaffId);
    const rows = (await json(await listBookings(req("/api/v1/bookings")))).data.bookings;
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(theirs);
  });

  test("bad list parameters are a 422", async () => {
    as("owner", w.staffId);
    const res = await listBookings(req("/api/v1/bookings?filter=sideways"));
    expect(res.status).toBe(422);
  });

  test("the calendar returns a range, scoped the same way", async () => {
    const from = tomorrow().minus({ days: 1 });
    const to = from.plus({ days: 5 });
    const url = `/api/v1/calendar?from=${encodeURIComponent(iso(from))}&to=${encodeURIComponent(iso(to))}`;
    as("owner", w.staffId);
    expect((await json(await getCalendar(req(url)))).data.events).toHaveLength(2);
    as("stylist", w.staffId);
    expect((await json(await getCalendar(req(url)))).data.events).toHaveLength(1);
  });

  test("a calendar range that is backwards or enormous is a 422", async () => {
    as("owner", w.staffId);
    const from = tomorrow();
    const bad = `/api/v1/calendar?from=${encodeURIComponent(iso(from))}&to=${encodeURIComponent(iso(from.minus({ days: 1 })))}`;
    expect((await getCalendar(req(bad))).status).toBe(422);
    const wide = `/api/v1/calendar?from=${encodeURIComponent(iso(from))}&to=${encodeURIComponent(iso(from.plus({ days: 200 })))}`;
    expect((await getCalendar(req(wide))).status).toBe(422);
  });

  test("one booking: found, someone else's looks missing to a stylist, junk id is 404", async () => {
    as("owner", w.staffId);
    expect((await getBooking(req("/x"), ctx(mine))).status).toBe(200);
    as("stylist", w.staffId);
    expect((await getBooking(req("/x"), ctx(theirs))).status).toBe(404);
    expect((await getBooking(req("/x"), ctx("not-a-uuid"))).status).toBe(404);
    expect((await getBooking(req("/x"), ctx("00000000-0000-4000-8000-000000000000"))).status).toBe(
      404,
    );
  });

  test("clients: search and profile", async () => {
    as("owner", w.staffId);
    const found = (await json(await searchClients(req("/api/v1/clients?q=sam")))).data.clients;
    expect(found.map((c: { id: string }) => c.id)).toEqual([w.clientId]);
    const profile = await json(await getClient(req("/x"), ctx(w.clientId)));
    expect(profile.data.id ?? profile.data.client?.id).toBeTruthy();
    expect((await getClient(req("/x"), ctx("00000000-0000-4000-8000-000000000000"))).status).toBe(
      404,
    );
  });
});

describe("resources and availability", () => {
  const day = () => DateTime.now().plus({ days: 3 }).toFormat("yyyy-MM-dd");
  const query = (extra = "") =>
    `/api/v1/availability?locationId=${w.locationId}&serviceIds=${w.haircutId}&fromDate=${day()}&toDate=${day()}${extra}`;

  test("resources: the owner sees every stylist, a stylist only themselves", async () => {
    as("owner", w.staffId);
    const all = (await json(await getResources(req("/api/v1/resources")))).data;
    expect(all.locations.map((l: { id: string }) => l.id)).toEqual([w.locationId]);
    expect(all.staff).toHaveLength(2);
    expect(all.services.map((x: { id: string }) => x.id)).toContain(w.haircutId);
    as("stylist", otherStaffId);
    const own = (await json(await getResources(req("/api/v1/resources")))).data;
    expect(own.staff.map((x: { id: string }) => x.id)).toEqual([otherStaffId]);
  });

  test("availability returns priced slots from the real engine", async () => {
    as("owner", w.staffId);
    const res = await getAvailability(req(query(`&staffId=${w.staffId}`)));
    expect(res.status).toBe(200);
    const { slots } = (await json(res)).data;
    expect(slots.length).toBeGreaterThan(0);
    expect(slots[0]).toMatchObject({ staffId: w.staffId, totalCents: 9500, durationMin: 45 });
  });

  test("a stylist can only ask about themselves", async () => {
    as("stylist", w.staffId);
    expect((await getAvailability(req(query(`&staffId=${otherStaffId}`)))).status).toBe(403);
    const own = await getAvailability(req(query()));
    expect(own.status).toBe(200);
    for (const slot of (await json(own)).data.slots) expect(slot.staffId).toBe(w.staffId);
  });

  test("bad dates, ranges and ids are a 422", async () => {
    as("owner", w.staffId);
    const base = `locationId=${w.locationId}&serviceIds=${w.haircutId}`;
    for (const q of [
      `${base}&fromDate=tomorrow&toDate=${day()}`,
      `${base}&fromDate=${day()}&toDate=2000-01-01`,
      `${base}&fromDate=2026-01-01&toDate=2026-06-01`,
      `locationId=nope&serviceIds=${w.haircutId}&fromDate=${day()}&toDate=${day()}`,
      `locationId=${w.locationId}&serviceIds=&fromDate=${day()}&toDate=${day()}`,
    ]) {
      expect((await getAvailability(req(`/api/v1/availability?${q}`))).status).toBe(422);
    }
  });

  test("signed out is 401", async () => {
    expect((await getResources(req("/api/v1/resources"))).status).toBe(401);
    expect((await getAvailability(req(query()))).status).toBe(401);
  });
});

describe("POST /bookings", () => {
  const valid = () => ({
    locationId: w.locationId,
    serviceIds: [w.haircutId],
    start: iso(tomorrow().plus({ days: 1 })),
    client: { existingClientId: w.clientId },
    notifyClient: false,
  });

  test("creates a booking and confirms it, with the client not told", async () => {
    as("owner", w.staffId);
    const res = await createBooking(req("/api/v1/bookings", { ...valid(), staffId: w.staffId }));
    expect(res.status).toBe(201);
    expect((await json(res)).data.bookingId).toBe("11111111-1111-4111-8111-111111111111");
    expect(state.domain.createHold).toHaveBeenCalledOnce();
    expect(state.domain.confirmBooking).toHaveBeenCalledOnce();
  });

  test("a stylist who names no one is booked into their own column", async () => {
    as("stylist", otherStaffId);
    const res = await createBooking(req("/api/v1/bookings", valid()));
    expect(res.status).toBe(201);
    expect(state.domain.createHold).toHaveBeenCalledWith(
      w.db,
      expect.objectContaining({ staffId: otherStaffId }),
    );
  });

  test("a stylist asking for someone else's column is refused, and no slot is held", async () => {
    as("stylist", otherStaffId);
    const res = await createBooking(req("/api/v1/bookings", { ...valid(), staffId: w.staffId }));
    expect(res.status).toBe(403);
    expect(state.domain.createHold).not.toHaveBeenCalled();
  });

  test("invalid fields are a 422 naming them; broken JSON is a 400", async () => {
    as("owner", w.staffId);
    const res = await createBooking(req("/api/v1/bookings", { ...valid(), serviceIds: [] }));
    expect(res.status).toBe(422);
    expect((await json(res)).error.fields).toHaveProperty("serviceIds");
    const broken = await createBooking(req("/api/v1/bookings", "{nope"));
    expect(broken.status).toBe(400);
    expect((await json(broken)).error.code).toBe("invalid_json");
  });

  test("the domain's refusals keep their meaning", async () => {
    as("owner", w.staffId);
    const { SlotTakenError } = await import("@/server/booking/errors");
    state.domain.createHold = vi.fn(async () => {
      throw new SlotTakenError();
    });
    const res = await createBooking(req("/api/v1/bookings", valid()));
    expect(res.status).toBe(409);
    expect((await json(res)).error.code).toBe("slot_taken");
  });
});

describe("booking actions", () => {
  test("cancel: refund or keep, and the outcome comes back", async () => {
    as("owner", w.staffId);
    const res = await cancel(req("/x", { depositMode: "keep", reason: "Unwell" }), ctx(mine));
    expect(res.status).toBe(200);
    expect((await json(res)).data).toMatchObject({ depositAction: "refund", feeCents: 0 });
    expect(state.domain.cancelBooking).toHaveBeenCalledWith(
      w.db,
      expect.objectContaining({ bookingId: mine, keepDeposit: true, by: "staff" }),
    );
  });

  test("cancel needs a deposit decision", async () => {
    as("owner", w.staffId);
    expect((await cancel(req("/x", {}), ctx(mine))).status).toBe(422);
  });

  test("a stylist cannot touch someone else's booking: it is a 404, and nothing runs", async () => {
    as("stylist", w.staffId);
    for (const call of [
      () => cancel(req("/x", { depositMode: "refund" }), ctx(theirs)),
      () => noShow(req("/x", {}), ctx(theirs)),
      () => reschedule(req("/x", { newStart: iso(tomorrow()), notifyClient: false }), ctx(theirs)),
      () => checkout(req("/x", { method: "cash" }), ctx(theirs)),
    ]) {
      expect((await call()).status).toBe(404);
    }
    expect(state.domain.cancelBooking).not.toHaveBeenCalled();
    expect(state.domain.markNoShow).not.toHaveBeenCalled();
  });

  test("no-show, reschedule and reassign", async () => {
    as("owner", w.staffId);
    expect((await noShow(req("/x", {}), ctx(mine))).status).toBe(200);
    const when = iso(tomorrow().plus({ days: 3 }));
    expect(
      (await reschedule(req("/x", { newStart: when, notifyClient: true }), ctx(mine))).status,
    ).toBe(200);
    expect(state.domain.rescheduleBooking).toHaveBeenCalledWith(
      w.db,
      expect.objectContaining({ bookingId: mine, notifyClient: true, by: "staff" }),
    );
    expect(
      (await reassign(req("/x", { newStaffId: otherStaffId, notifyClient: false }), ctx(mine)))
        .status,
    ).toBe(200);
  });

  test("a stylist cannot reassign: 403", async () => {
    as("stylist", w.staffId);
    const res = await reassign(
      req("/x", { newStaffId: otherStaffId, notifyClient: false }),
      ctx(mine),
    );
    expect(res.status).toBe(403);
    expect((await json(res)).error.code).toBe("forbidden");
  });

  test("checkout records the balance paid outside the app", async () => {
    as("owner", w.staffId);
    await w.db
      .update(booking)
      .set({ totalCents: 9500, depositCents: 4750 })
      .where(eq(booking.id, mine));
    await w.db.insert(payment).values({
      bookingId: mine,
      kind: "deposit",
      method: "stripe_online",
      status: "succeeded",
      amountCents: 4750,
      stripePaymentIntentId: "pi_test",
    });
    const res = await checkout(req("/x", { method: "cash" }), ctx(mine));
    expect(res.status).toBe(200);
    expect(state.domain.recordManualPayment).toHaveBeenCalled();
    expect((await checkout(req("/x", { method: "bitcoin" }), ctx(mine))).status).toBe(422);
  });

  test("reception can book and cancel but not use the owner-only import", async () => {
    as("reception", null);
    expect((await noShow(req("/x", {}), ctx(mine))).status).toBe(200);
    const me = (await json(await getMe())).data;
    expect(me.permissions).toContain("booking.create");
    expect(me.permissions).not.toContain("data.import");
  });
});

describe("Tap to Pay", () => {
  const started = {
    paymentId: "11111111-1111-4111-8111-111111111111",
    paymentIntentId: "pi_1",
    clientSecret: "pi_1_secret",
    amountCents: 4750,
  };
  beforeEach(() => {
    pay.start.mockReset().mockResolvedValue(started);
    pay.status
      .mockReset()
      .mockResolvedValue({ status: "pending", bookingStatus: "confirmed", balanceDueCents: 4750 });
    pay.token.mockReset().mockResolvedValue({ secret: "pst_1" });
    pay.location.mockReset().mockReturnValue("tml_1");
  });

  test("terminal config says whether Tap to Pay is set up", async () => {
    as("owner", w.staffId);
    expect((await json(await terminalConfig(req("/x")))).data).toEqual({
      configured: true,
      locationId: "tml_1",
    });
    pay.location.mockReturnValue(null);
    expect((await json(await terminalConfig(req("/x")))).data).toEqual({
      configured: false,
      locationId: null,
    });
  });

  test("a connection token is handed to the app", async () => {
    as("stylist", w.staffId);
    const res = await connectionToken(req("/x", {}));
    expect(res.status).toBe(200);
    expect((await json(res)).data).toEqual({ secret: "pst_1" });
  });

  test("starting a payment returns the client secret and amount; the amount comes from the server", async () => {
    as("owner", w.staffId);
    const res = await cardStart(req("/x", { amountCents: 1 }), ctx(mine));
    expect(res.status).toBe(201);
    expect((await json(res)).data).toEqual(started);
    expect(pay.start).toHaveBeenCalledWith(w.db, mine);
  });

  test("a stylist can take payment on their own booking but not on a colleague's", async () => {
    as("stylist", w.staffId);
    expect((await cardStart(req("/x", {}), ctx(mine))).status).toBe(201);
    pay.start.mockClear();
    const res = await cardStart(req("/x", {}), ctx(theirs));
    expect(res.status).toBe(404);
    expect(pay.start).not.toHaveBeenCalled();
  });

  test.each([
    ["nothing_owing", 409, "invalid_state"],
    ["booking_not_payable", 409, "invalid_state"],
    ["stripe_not_configured", 503, "payments_unavailable"],
    ["stripe_error", 502, "payment_provider_error"],
    ["booking_not_found", 404, "not_found"],
  ] as const)("a %s payment error becomes %i %s", async (code, status, apiCode) => {
    as("owner", w.staffId);
    pay.start.mockRejectedValue(new PaymentError(code, "internal detail sk_live_secret"));
    const res = await cardStart(req("/x", {}), ctx(mine));
    expect(res.status).toBe(status);
    const body = await json(res);
    expect(body.error.code).toBe(apiCode);
    if (status >= 500) expect(JSON.stringify(body)).not.toContain("sk_live_secret");
  });

  test("polling the payment needs a valid payment id and returns where it stands", async () => {
    as("owner", w.staffId);
    const ok = await cardStatus(req(`/x?paymentId=${started.paymentId}`), ctx(mine));
    expect(ok.status).toBe(200);
    expect((await json(ok)).data).toEqual({
      status: "pending",
      bookingStatus: "confirmed",
      balanceDueCents: 4750,
    });
    expect((await cardStatus(req("/x?paymentId=nope"), ctx(mine))).status).toBe(422);
    expect((await cardStatus(req("/x"), ctx(mine))).status).toBe(422);
  });

  test("signed out is 401", async () => {
    state.viewer = null;
    expect((await cardStart(req("/x", {}), ctx(mine))).status).toBe(401);
    expect((await connectionToken(req("/x", {}))).status).toBe(401);
    expect((await terminalConfig(req("/x"))).status).toBe(401);
  });
});

describe("push devices", () => {
  const TOKEN = "ExponentPushToken[abc123]";
  const del = (body: unknown) =>
    new Request(`${ORIGIN}/api/v1/devices`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  test("registers this phone for the signed-in person, and repeating it is harmless", async () => {
    as("stylist", otherStaffId);
    expect((await addDevice(req("/x", { token: TOKEN }))).status).toBe(200);
    expect((await addDevice(req("/x", { token: TOKEN }))).status).toBe(200);
    const rows = await w.db.select().from(deviceToken);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ token: TOKEN, staffId: otherStaffId });
  });

  test("signing in on the same phone as someone else takes it over", async () => {
    as("stylist", otherStaffId);
    await addDevice(req("/x", { token: TOKEN }));
    as("owner", w.staffId);
    await addDevice(req("/x", { token: TOKEN }));
    expect((await w.db.select().from(deviceToken))[0].staffId).toBe(w.staffId);
  });

  test("removes the phone on sign-out, only for its current owner", async () => {
    as("stylist", otherStaffId);
    await addDevice(req("/x", { token: TOKEN }));
    as("owner", w.staffId);
    await removeDevice(del({ token: TOKEN }));
    expect(await w.db.select().from(deviceToken)).toHaveLength(1);
    as("stylist", otherStaffId);
    expect((await removeDevice(del({ token: TOKEN }))).status).toBe(200);
    expect(await w.db.select().from(deviceToken)).toHaveLength(0);
  });

  test("a malformed token is a 422; a missing one too", async () => {
    as("owner", w.staffId);
    expect((await addDevice(req("/x", { token: "definitely-not-expo" }))).status).toBe(422);
    expect((await addDevice(req("/x", {}))).status).toBe(422);
  });

  test("someone not linked to a staff profile cannot register one", async () => {
    as("owner", null);
    const res = await addDevice(req("/x", { token: TOKEN }));
    expect(res.status).toBe(409);
  });

  test("signed out is 401", async () => {
    expect((await addDevice(req("/x", { token: TOKEN }))).status).toBe(401);
    expect((await removeDevice(del({ token: TOKEN }))).status).toBe(401);
  });
});
