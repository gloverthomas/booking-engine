import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { DateTime } from "luxon";
import { eq } from "drizzle-orm";
import { booking, bookingService, payment, waitlistEntry } from "@/db/schema";
import { OPERATIONS } from "@/server/api/openapi";
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
import { GET as listWaitlistRoute } from "@/app/api/v1/waitlist/route";
import { DELETE as removeWaitlistRoute } from "@/app/api/v1/waitlist/[id]/route";
import { GET as waitlistSlotsRoute } from "@/app/api/v1/waitlist/[id]/slots/route";
import { POST as waitlistOfferRoute } from "@/app/api/v1/waitlist/[id]/offer/route";
import {
  GET as listExceptionsRoute,
  POST as setExceptionRoute,
} from "@/app/api/v1/roster/exceptions/route";
import { DELETE as removeExceptionRoute } from "@/app/api/v1/roster/exceptions/[id]/route";
import { GET as myWeekRoute } from "@/app/api/v1/timesheets/week/route";
import { GET as rescheduleSlotsRoute } from "@/app/api/v1/bookings/[id]/reschedule-slots/route";
import { GET as getRoster } from "@/app/api/v1/roster/route";
import { GET as getClock } from "@/app/api/v1/timesheets/clock/route";
import { POST as clockIn } from "@/app/api/v1/timesheets/clock/in/route";
import { POST as clockOut } from "@/app/api/v1/timesheets/clock/out/route";
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

describe("roster", () => {
  const monday = "2026-11-02";

  test("the owner sees every active stylist; each day lists where and when", async () => {
    as("owner", w.staffId);
    const res = await getRoster(req(`/api/v1/roster?week=${monday}`));
    expect(res.status).toBe(200);
    const { data } = await json(res);
    expect(data).toMatchObject({
      weekStart: monday,
      timezone: "Australia/Melbourne",
      scope: "all",
      canEdit: true,
    });
    expect(data.dates).toHaveLength(7);
    expect(data.rows.map((r: { name: string }) => r.name).sort()).toEqual(["Alex", "Ryan"]);
    const ryan = data.rows.find((r: { staffId: string }) => r.staffId === w.staffId);
    expect(ryan.days).toHaveLength(7);
    expect(ryan.days[0].entries[0]).toMatchObject({
      locationId: w.locationId,
      kind: "weekly",
      ranges: [{ startMinute: 540, endMinute: 1020 }],
    });
    const alex = data.rows.find((r: { staffId: string }) => r.staffId === otherStaffId);
    expect(alex.days.every((d: { entries: unknown[] }) => d.entries.length === 0)).toBe(true);
  });

  test("any date in the week gives that week's Monday; no week means this week", async () => {
    as("owner", w.staffId);
    expect(
      (await json(await getRoster(req("/api/v1/roster?week=2026-11-05")))).data.weekStart,
    ).toBe(monday);
    const now = (await json(await getRoster(req("/api/v1/roster")))).data;
    expect(now.dates).toContain(now.today);
  });

  test("a stylist sees only their own row and cannot edit", async () => {
    as("stylist", w.staffId);
    const { data } = await json(await getRoster(req(`/api/v1/roster?week=${monday}`)));
    expect(data.scope).toBe("own");
    expect(data.canEdit).toBe(false);
    expect(data.rows.map((r: { staffId: string }) => r.staffId)).toEqual([w.staffId]);
  });

  test("a stylist with no staff profile gets an empty roster, not everyone's", async () => {
    as("stylist", null);
    const { data } = await json(await getRoster(req(`/api/v1/roster?week=${monday}`)));
    expect(data.rows).toEqual([]);
  });

  test("reception sees everyone", async () => {
    as("reception", null);
    const { data } = await json(await getRoster(req(`/api/v1/roster?week=${monday}`)));
    expect(data.rows).toHaveLength(2);
  });

  test("a bad week is a 422; signed out is 401", async () => {
    as("owner", w.staffId);
    expect((await getRoster(req("/api/v1/roster?week=next-tuesday"))).status).toBe(422);
    state.viewer = null;
    expect((await getRoster(req("/api/v1/roster"))).status).toBe(401);
  });
});

describe("clock in and out", () => {
  test("starts out of a shift, with the locations to choose from", async () => {
    as("stylist", w.staffId);
    const { data } = await json(await getClock(req("/api/v1/timesheets/clock")));
    expect(data).toMatchObject({ available: true, open: null });
    expect(data.locations).toEqual([{ id: w.locationId, name: "Northside" }]);
    expect(typeof data.serverNow).toBe("string");
  });

  test("a full shift: in, shown as open, out, and a second out is refused", async () => {
    as("stylist", w.staffId);
    const started = await clockIn(req("/x", { locationId: w.locationId }));
    expect(started.status).toBe(200);
    expect((await json(started)).data.entryId).toBeTruthy();

    const open = (await json(await getClock(req("/x")))).data.open;
    expect(open).toMatchObject({ locationName: "Northside" });
    expect(open.sinceLabel).toBeTruthy();

    const finished = await clockOut(req("/x", { breakMinutes: 0 }));
    expect(finished.status).toBe(200);
    expect((await json(await getClock(req("/x")))).data.open).toBeNull();

    const again = await clockOut(req("/x", {}));
    expect(again.status).toBe(409);
    expect((await json(again)).error.code).toBe("invalid_state");
  });

  test("clocking in twice is refused with a clear message", async () => {
    as("stylist", w.staffId);
    await clockIn(req("/x", {}));
    const second = await clockIn(req("/x", {}));
    expect(second.status).toBe(409);
    expect((await json(second)).error.message).toContain("already clocked in");
  });

  test("it is always the signed-in person: a colleague's clock is untouched", async () => {
    as("stylist", w.staffId);
    await clockIn(req("/x", {}));
    as("stylist", otherStaffId);
    expect((await json(await getClock(req("/x")))).data.open).toBeNull();
  });

  test("a break longer than the shift is refused", async () => {
    as("stylist", w.staffId);
    await clockIn(req("/x", {}));
    const res = await clockOut(req("/x", { breakMinutes: 30 }));
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    // The shift stays open so they can try again with the right break.
    expect((await json(await getClock(req("/x")))).data.open).not.toBeNull();
  });

  test("an unknown location or a silly break is refused with the field named", async () => {
    as("stylist", w.staffId);
    const bad = await clockIn(req("/x", { locationId: "00000000-0000-4000-8000-000000000000" }));
    expect([400, 422]).toContain(bad.status);
    await clockIn(req("/x", {}));
    const silly = await clockOut(req("/x", { breakMinutes: 100000 }));
    expect(silly.status).toBe(422);
  });

  test("someone without a staff profile cannot clock in, and is told why", async () => {
    as("owner", null);
    expect((await json(await getClock(req("/x")))).data).toEqual({ available: false });
    const res = await clockIn(req("/x", {}));
    expect(res.status).toBe(409);
    expect((await json(res)).error.code).toBe("no_staff_profile");
  });

  test("signed out is 401", async () => {
    expect((await getClock(req("/x"))).status).toBe(401);
    expect((await clockIn(req("/x", {}))).status).toBe(401);
    expect((await clockOut(req("/x", {}))).status).toBe(401);
  });
});

describe("reschedule slots", () => {
  /** Ryan is rostered 9-5 daily; put his appointment at 10:00 three days from now, and a colleague-sized obstacle at 12:00. */
  const at = (hour: number) =>
    DateTime.now()
      .setZone("Australia/Melbourne")
      .plus({ days: 3 })
      .set({ hour, minute: 0, second: 0, millisecond: 0 });
  const day = () => at(10).toFormat("yyyy-MM-dd");
  const url = (id: string, extra = "") => `/x?fromDate=${day()}&toDate=${day()}${extra}`;
  let own: string;

  async function bookWith(startHour: number, serviceId: string | null, staffId = w.staffId) {
    const start = at(startHour);
    const row = await addBooking(
      w.db,
      { ...w, staffId },
      start.toJSDate(),
      start.plus({ minutes: 45 }).toJSDate(),
    );
    await w.db.insert(bookingService).values({
      bookingId: row.id,
      serviceId,
      name: "Maintenance Haircut",
      durationMin: 45,
      priceCents: 9500,
    });
    return row.id;
  }

  beforeEach(async () => {
    own = await bookWith(10, w.haircutId);
  });

  test("offers times for the same stylist, counting the appointment's own slot as free", async () => {
    as("owner", w.staffId);
    await bookWith(12, w.haircutId); // someone else's booking in the way
    const res = await rescheduleSlotsRoute(req(url(own)), ctx(own));
    expect(res.status).toBe(200);
    const { data } = await json(res);
    expect(data.reason).toBeNull();
    const starts = data.slots.map((s: { start: string }) => s.start);
    expect(starts).toContain(at(10).toUTC().toISO({ suppressMilliseconds: false }));
    expect(starts).toContain(at(10).plus({ minutes: 15 }).toUTC().toISO());
    expect(starts).not.toContain(at(12).toUTC().toISO());
    expect(data.slots.every((s: { staffId: string }) => s.staffId === w.staffId)).toBe(true);
    expect(data.current.start).toBe(at(10).toUTC().toISO());
  });

  test("a stylist can move their own appointment but not a colleague's", async () => {
    const theirs = await bookWith(14, w.haircutId, otherStaffId);
    as("stylist", w.staffId);
    expect((await rescheduleSlotsRoute(req(url(own)), ctx(own))).status).toBe(200);
    expect((await rescheduleSlotsRoute(req(url(theirs)), ctx(theirs))).status).toBe(404);
  });

  test("a service that is not in the catalogue means no suggestions, with the reason", async () => {
    as("owner", w.staffId);
    const imported = await bookWith(15, null);
    const { data } = await json(await rescheduleSlotsRoute(req(url(imported)), ctx(imported)));
    expect(data.slots).toEqual([]);
    expect(data.reason).toBe("services_not_in_catalogue");
    expect(data.current.start).toBe(at(15).toUTC().toISO());
  });

  test("only a confirmed appointment can be moved", async () => {
    as("owner", w.staffId);
    await w.db.update(booking).set({ status: "completed" }).where(eq(booking.id, own));
    const res = await rescheduleSlotsRoute(req(url(own)), ctx(own));
    expect(res.status).toBe(400);
    expect((await json(res)).error.message).toContain("confirmed");
  });

  test("bad or oversized date ranges are a 422; an unknown id is a 404; signed out is 401", async () => {
    as("owner", w.staffId);
    expect(
      (await rescheduleSlotsRoute(req("/x?fromDate=soon&toDate=later"), ctx(own))).status,
    ).toBe(422);
    expect(
      (await rescheduleSlotsRoute(req("/x?fromDate=2026-01-01&toDate=2026-06-01"), ctx(own)))
        .status,
    ).toBe(422);
    expect(
      (await rescheduleSlotsRoute(req(url(own)), ctx("00000000-0000-4000-8000-000000000000")))
        .status,
    ).toBe(404);
    state.viewer = null;
    expect((await rescheduleSlotsRoute(req(url(own)), ctx(own))).status).toBe(401);
  });

  test("the plain availability search still treats the appointment's slot as taken", async () => {
    // The exclusion is specific to this endpoint: it must not leak into the normal search.
    as("owner", w.staffId);
    const q = `/api/v1/availability?locationId=${w.locationId}&serviceIds=${w.haircutId}&fromDate=${day()}&toDate=${day()}&staffId=${w.staffId}`;
    const starts = (await json(await getAvailability(req(q)))).data.slots.map(
      (s: { start: string }) => s.start,
    );
    expect(starts).not.toContain(at(10).toUTC().toISO());
  });
});

describe("waitlist", () => {
  const ZONE = "Australia/Melbourne";
  const inDays = (n: number) =>
    DateTime.now().setZone(ZONE).plus({ days: n }).toISODate() as string;
  let entryId: string;

  beforeEach(async () => {
    const [row] = await w.db
      .insert(waitlistEntry)
      .values({
        clientId: w.clientId,
        locationId: w.locationId,
        serviceIds: [w.haircutId],
        earliestDate: inDays(1),
        latestDate: inDays(10),
        expiresAt: DateTime.now().plus({ days: 11 }).toJSDate(),
      })
      .returning();
    entryId = row.id;
  });
  const del = (id: string) =>
    removeWaitlistRoute(new Request(`${ORIGIN}/x`, { method: "DELETE" }), ctx(id));

  test("lists who is waiting, by name, with the services they want", async () => {
    as("owner", w.staffId);
    const { data } = await json(await listWaitlistRoute(req("/x")));
    expect(data.entries).toHaveLength(1);
    expect(data.entries[0]).toMatchObject({
      id: entryId,
      status: "waiting",
      clientName: "Sam Client",
      serviceNames: ["Maintenance Haircut"],
      offers: [],
    });
    expect((await json(await listWaitlistRoute(req("/x?view=history")))).data.entries).toEqual([]);
  });

  test("owner, manager and reception can see it; a stylist cannot", async () => {
    for (const role of ["owner", "manager", "reception"] as const) {
      as(role, null);
      expect((await listWaitlistRoute(req("/x"))).status).toBe(200);
    }
    as("stylist", w.staffId);
    expect((await listWaitlistRoute(req("/x"))).status).toBe(403);
    expect((await waitlistSlotsRoute(req("/x"), ctx(entryId))).status).toBe(403);
  });

  test("finds open times that suit them, then offers one", async () => {
    as("owner", w.staffId);
    const found = await json(await waitlistSlotsRoute(req("/x"), ctx(entryId)));
    expect(found.data.timezone).toBe(ZONE);
    expect(found.data.slots.length).toBeGreaterThan(0);
    const slot = found.data.slots[0];
    expect(slot.staffId).toBe(w.staffId);

    const res = await waitlistOfferRoute(
      req("/x", { staffId: slot.staffId, start: slot.start, end: slot.end }),
      ctx(entryId),
    );
    expect(res.status).toBe(201);
    expect((await json(res)).data.offerId).toBeTruthy();

    const after = (await json(await listWaitlistRoute(req("/x")))).data.entries[0];
    expect(after.status).toBe("offered");
    expect(after.offers).toHaveLength(1);
    expect(after.offers[0]).toMatchObject({ status: "sent", offeredBy: `owner:u-owner` });
  });

  test("offering a time that is not free is a 409, and a bad body a 422", async () => {
    as("owner", w.staffId);
    const taken = DateTime.now()
      .setZone(ZONE)
      .plus({ days: 3 })
      .set({ hour: 3, minute: 0, second: 0, millisecond: 0 });
    const res = await waitlistOfferRoute(
      req("/x", {
        staffId: w.staffId,
        start: taken.toUTC().toISO(),
        end: taken.plus({ minutes: 45 }).toUTC().toISO(),
      }),
      ctx(entryId),
    );
    expect([409, 422]).toContain(res.status);
    expect((await waitlistOfferRoute(req("/x", { staffId: "nope" }), ctx(entryId))).status).toBe(
      422,
    );
  });

  test("removing someone takes them off the active list", async () => {
    as("reception", null);
    expect((await json(await del(entryId))).data).toEqual({ removed: true });
    expect((await json(await listWaitlistRoute(req("/x")))).data.entries).toEqual([]);
    expect(
      (await json(await listWaitlistRoute(req("/x?view=history")))).data.entries[0].status,
    ).toBe("cancelled");
  });

  test("an unknown or malformed id is a 404; signed out is 401", async () => {
    as("owner", w.staffId);
    expect((await waitlistSlotsRoute(req("/x"), ctx("not-a-uuid"))).status).toBe(404);
    expect(
      (await waitlistSlotsRoute(req("/x"), ctx("00000000-0000-4000-8000-000000000000"))).status,
    ).toBe(404);
    state.viewer = null;
    expect((await listWaitlistRoute(req("/x"))).status).toBe(401);
    expect((await del(entryId)).status).toBe(401);
  });
});

describe("roster editing", () => {
  const ZONE = "Australia/Melbourne";
  const inDays = (n: number) =>
    DateTime.now().setZone(ZONE).plus({ days: n }).toISODate() as string;
  const del = (id: string) =>
    removeExceptionRoute(new Request(`${ORIGIN}/x`, { method: "DELETE" }), ctx(id));

  test("a day off appears in the exceptions list and in the roster", async () => {
    as("owner", w.staffId);
    const date = inDays(5);
    const res = await setExceptionRoute(
      req("/x", { kind: "off", staffId: otherStaffId, date, locationId: null, note: "Holiday" }),
    );
    expect(res.status).toBe(201);
    expect((await json(res)).data).toMatchObject({ conflictingBookings: 0 });

    const list = (await json(await listExceptionsRoute(req("/x")))).data.exceptions;
    expect(list).toEqual([
      expect.objectContaining({ staffId: otherStaffId, date, kind: "off", note: "Holiday" }),
    ]);

    const roster = (await json(await getRoster(req(`/x?week=${date}`)))).data;
    const alex = roster.rows.find((r: { staffId: string }) => r.staffId === otherStaffId);
    expect(alex.days.find((d: { date: string }) => d.date === date).off).toMatchObject({
      note: "Holiday",
      everywhere: true,
    });
  });

  test("changed hours replace the weekly pattern for that day", async () => {
    as("manager", null);
    const date = inDays(6);
    const res = await setExceptionRoute(
      req("/x", {
        kind: "custom",
        staffId: w.staffId,
        date,
        locationId: w.locationId,
        ranges: [{ startMinute: 600, endMinute: 900 }],
      }),
    );
    expect(res.status).toBe(201);
    const roster = (await json(await getRoster(req(`/x?week=${date}`)))).data;
    const ryan = roster.rows.find((r: { staffId: string }) => r.staffId === w.staffId);
    expect(ryan.days.find((d: { date: string }) => d.date === date).entries[0]).toMatchObject({
      kind: "custom",
      ranges: [{ startMinute: 600, endMinute: 900 }],
    });
  });

  test("it warns how many existing bookings now fall outside the roster, but still makes the change", async () => {
    as("owner", w.staffId);
    const bookedOn = DateTime.fromJSDate(
      (await w.db.select().from(booking).where(eq(booking.id, mine)))[0].during.start,
      { zone: ZONE },
    ).toISODate() as string;
    const res = await setExceptionRoute(
      req("/x", { kind: "off", staffId: w.staffId, date: bookedOn, locationId: null }),
    );
    expect(res.status).toBe(201);
    expect((await json(res)).data.conflictingBookings).toBeGreaterThanOrEqual(1);
  });

  test("a past date and an impossible range are refused with the field named", async () => {
    as("owner", w.staffId);
    const past = await setExceptionRoute(
      req("/x", { kind: "off", staffId: w.staffId, date: inDays(-3), locationId: null }),
    );
    expect(past.status).toBe(422);
    expect((await json(past)).error.fields).toHaveProperty("date");
    const backwards = await setExceptionRoute(
      req("/x", {
        kind: "custom",
        staffId: w.staffId,
        date: inDays(4),
        locationId: w.locationId,
        ranges: [{ startMinute: 900, endMinute: 600 }],
      }),
    );
    expect(backwards.status).toBe(422);
    expect((await setExceptionRoute(req("/x", { kind: "sideways" }))).status).toBe(422);
  });

  test("only owner and manager can edit; others are 403 and nothing is saved", async () => {
    for (const [role, staffId] of [
      ["stylist", w.staffId],
      ["reception", null],
    ] as const) {
      as(role, staffId);
      const res = await setExceptionRoute(
        req("/x", { kind: "off", staffId: w.staffId, date: inDays(5), locationId: null }),
      );
      expect(res.status).toBe(403);
    }
    as("owner", w.staffId);
    expect((await json(await listExceptionsRoute(req("/x")))).data.exceptions).toEqual([]);
  });

  test("a stylist can see their own days off but not a colleague's", async () => {
    as("owner", w.staffId);
    await setExceptionRoute(
      req("/x", { kind: "off", staffId: w.staffId, date: inDays(5), locationId: null }),
    );
    await setExceptionRoute(
      req("/x", { kind: "off", staffId: otherStaffId, date: inDays(6), locationId: null }),
    );
    as("stylist", w.staffId);
    const own = (await json(await listExceptionsRoute(req("/x")))).data.exceptions;
    expect(own.map((e: { staffId: string }) => e.staffId)).toEqual([w.staffId]);
  });

  test("removing an exception puts the weekly hours back; removing it twice is a 404", async () => {
    as("owner", w.staffId);
    await setExceptionRoute(
      req("/x", { kind: "off", staffId: w.staffId, date: inDays(5), locationId: null }),
    );
    const [row] = (await json(await listExceptionsRoute(req("/x")))).data.exceptions;
    expect((await del(row.id)).status).toBe(200);
    expect((await json(await listExceptionsRoute(req("/x")))).data.exceptions).toEqual([]);
    expect((await del(row.id)).status).toBe(404);
  });

  test("signed out is 401", async () => {
    expect((await listExceptionsRoute(req("/x"))).status).toBe(401);
    expect((await setExceptionRoute(req("/x", {}))).status).toBe(401);
  });
});

describe("my hours", () => {
  const weekOf = DateTime.now().setZone("Australia/Melbourne").toISODate() as string;

  test("shows the signed-in person's week: hours rostered, and a shift they worked", async () => {
    as("stylist", w.staffId);
    await clockIn(req("/x", {}));
    const { data } = await json(await myWeekRoute(req(`/x?week=${weekOf}`)));
    expect(data.available).toBe(true);
    expect(data.sheet.staffId).toBe(w.staffId);
    expect(data.sheet.days).toHaveLength(7);
    expect(data.sheet.rosteredMinutes).toBe(7 * 8 * 60);
    expect(data.sheet.hasOpenEntry).toBe(true);
  });

  test("it is only ever their own week, whoever asks", async () => {
    as("owner", w.staffId);
    expect((await json(await myWeekRoute(req(`/x?week=${weekOf}`)))).data.sheet.staffId).toBe(
      w.staffId,
    );
    as("stylist", otherStaffId);
    expect((await json(await myWeekRoute(req(`/x?week=${weekOf}`)))).data.sheet.staffId).toBe(
      otherStaffId,
    );
  });

  test("a login with no staff profile has no timesheet, and a bad week is a 422", async () => {
    as("owner", null);
    expect((await json(await myWeekRoute(req("/x")))).data).toEqual({ available: false });
    as("owner", w.staffId);
    expect((await myWeekRoute(req("/x?week=whenever"))).status).toBe(422);
  });

  test("signed out is 401", async () => {
    expect((await myWeekRoute(req("/x"))).status).toBe(401);
  });
});

describe("response contract: real responses match the OpenAPI schemas", () => {
  const ZONE = "Australia/Melbourne";
  const inDays = (n: number) =>
    DateTime.now().setZone(ZONE).plus({ days: n }).toISODate() as string;
  const at = (hour: number) =>
    DateTime.now()
      .setZone(ZONE)
      .plus({ days: 3 })
      .set({ hour, minute: 0, second: 0, millisecond: 0 });

  /** The response must satisfy the strict schema the document is generated from, and nothing else may be in the body. */
  async function conforms(id: string, res: Response) {
    const operation = OPERATIONS.find((o) => o.id === id);
    expect(operation, `${id} is not in the registry`).toBeTruthy();
    const body = await res.json();
    expect(res.status, `${id}: ${JSON.stringify(body)}`).toBeLessThan(300);
    if (operation?.response) {
      const parsed = operation.response.safeParse(body.data);
      expect(
        parsed.success,
        `${id}: ${parsed.success ? "" : JSON.stringify(parsed.error.issues, null, 2)}`,
      ).toBe(true);
      expect(Object.keys(body)).toEqual(["data"]);
    } else {
      expect(body).toEqual({});
    }
    return body.data;
  }

  test("session, resources and reads", async () => {
    as("owner", w.staffId);
    await conforms("me", await getMe());
    await conforms("resources", await getResources(req("/x")));
    const day = inDays(3);
    await conforms(
      "availability",
      await getAvailability(
        req(
          `/x?locationId=${w.locationId}&serviceIds=${w.haircutId}&fromDate=${day}&toDate=${day}`,
        ),
      ),
    );
    const from = DateTime.now().minus({ days: 1 }).toUTC().toISO();
    const to = DateTime.now().plus({ days: 10 }).toUTC().toISO();
    const events = await conforms(
      "calendar",
      await getCalendar(req(`/x?from=${encodeURIComponent(from!)}&to=${encodeURIComponent(to!)}`)),
    );
    expect(events.events.length).toBeGreaterThan(0);
    await conforms("listBookings", await listBookings(req("/x")));
    await conforms("getBooking", await getBooking(req("/x"), ctx(mine)));
    await conforms("searchClients", await searchClients(req("/x?q=sam")));
    await conforms("getClient", await getClient(req("/x"), ctx(w.clientId)));
  });

  test("a booking with payments, messages and audit trail", async () => {
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
      stripePaymentIntentId: "pi_c",
    });
    const detail = await conforms("getBooking", await getBooking(req("/x"), ctx(mine)));
    expect(detail.payments).toHaveLength(1);
    await conforms("getClient", await getClient(req("/x"), ctx(w.clientId)));
  });

  test("roster, exceptions and timesheets", async () => {
    as("owner", w.staffId);
    await conforms("roster", await getRoster(req("/x")));
    const created = await conforms(
      "setRosterException",
      await setExceptionRoute(
        req("/x", {
          kind: "off",
          staffId: otherStaffId,
          date: inDays(5),
          locationId: null,
          note: "Away",
        }),
      ),
    );
    expect(created.ids).toHaveLength(1);
    await conforms(
      "setRosterException",
      await setExceptionRoute(
        req("/x", {
          kind: "custom",
          staffId: w.staffId,
          date: inDays(6),
          locationId: w.locationId,
          ranges: [{ startMinute: 600, endMinute: 900 }],
        }),
      ),
    );
    const list = await conforms("listRosterExceptions", await listExceptionsRoute(req("/x")));
    await conforms(
      "removeRosterException",
      await removeExceptionRoute(
        new Request(`${ORIGIN}/x`, { method: "DELETE" }),
        ctx(list.exceptions[0].id),
      ),
    );

    as("stylist", w.staffId);
    await conforms("clockState", await getClock(req("/x")));
    await conforms("clockIn", await clockIn(req("/x", {})));
    const open = await conforms("clockState", await getClock(req("/x")));
    expect(open.open).not.toBeNull();
    await conforms("clockOut", await clockOut(req("/x", { breakMinutes: 0 })));
    const week = await conforms("myWeek", await myWeekRoute(req("/x")));
    expect(week.available).toBe(true);
    as("owner", null);
    expect((await conforms("clockState", await getClock(req("/x")))).available).toBe(false);
    expect((await conforms("myWeek", await myWeekRoute(req("/x")))).available).toBe(false);
  });

  test("waitlist", async () => {
    as("owner", w.staffId);
    const [entry] = await w.db
      .insert(waitlistEntry)
      .values({
        clientId: w.clientId,
        locationId: w.locationId,
        serviceIds: [w.haircutId],
        earliestDate: inDays(1),
        latestDate: inDays(10),
        weekdays: [1, 2, 3],
        fromMinute: 540,
        toMinute: 1020,
        notes: "Mornings",
        expiresAt: DateTime.now().plus({ days: 11 }).toJSDate(),
      })
      .returning();
    const listed = await conforms("listWaitlist", await listWaitlistRoute(req("/x")));
    expect(listed.entries[0].weekdays).toEqual([1, 2, 3]);
    const found = await conforms(
      "waitlistSlots",
      await waitlistSlotsRoute(req("/x"), ctx(entry.id)),
    );
    const slot = found.slots[0];
    await conforms(
      "offerWaitlistSlot",
      await waitlistOfferRoute(
        req("/x", { staffId: slot.staffId, start: slot.start, end: slot.end }),
        ctx(entry.id),
      ),
    );
    const offered = await conforms("listWaitlist", await listWaitlistRoute(req("/x")));
    expect(offered.entries[0].offers).toHaveLength(1);
    await conforms(
      "removeFromWaitlist",
      await removeWaitlistRoute(new Request(`${ORIGIN}/x`, { method: "DELETE" }), ctx(entry.id)),
    );
  });

  test("appointment actions", async () => {
    as("owner", w.staffId);
    await conforms(
      "createBooking",
      await createBooking(
        req("/x", {
          locationId: w.locationId,
          serviceIds: [w.haircutId],
          start: at(11).toUTC().toISO(),
          client: { existingClientId: w.clientId },
          notifyClient: false,
        }),
      ),
    );
    await conforms("cancelBooking", await cancel(req("/x", { depositMode: "keep" }), ctx(mine)));
    await conforms("markNoShow", await noShow(req("/x", {}), ctx(mine)));
    await conforms(
      "rescheduleBooking",
      await reschedule(
        req("/x", { newStart: at(15).toUTC().toISO(), notifyClient: false }),
        ctx(mine),
      ),
    );
    await conforms(
      "reassignBooking",
      await reassign(req("/x", { newStaffId: otherStaffId, notifyClient: false }), ctx(mine)),
    );
    await w.db.update(booking).set({ totalCents: 9500 }).where(eq(booking.id, mine));
    await conforms("checkoutBooking", await checkout(req("/x", { method: "cash" }), ctx(mine)));
  });

  test("reschedule slots", async () => {
    as("owner", w.staffId);
    const start = at(10);
    const row = await addBooking(
      w.db,
      { ...w, staffId: w.staffId },
      start.toJSDate(),
      start.plus({ minutes: 45 }).toJSDate(),
    );
    await w.db.insert(bookingService).values({
      bookingId: row.id,
      serviceId: w.haircutId,
      name: "Maintenance Haircut",
      durationMin: 45,
      priceCents: 9500,
    });
    const day = start.toFormat("yyyy-MM-dd");
    const data = await conforms(
      "rescheduleSlots",
      await rescheduleSlotsRoute(req(`/x?fromDate=${day}&toDate=${day}`), ctx(row.id)),
    );
    expect(data.slots.length).toBeGreaterThan(0);
    const imported = await addBooking(
      w.db,
      { ...w, staffId: w.staffId },
      at(14).toJSDate(),
      at(14).plus({ minutes: 45 }).toJSDate(),
    );
    await w.db.insert(bookingService).values({
      bookingId: imported.id,
      serviceId: null,
      name: "Imported",
      durationMin: 45,
      priceCents: 9500,
    });
    expect(
      (
        await conforms(
          "rescheduleSlots",
          await rescheduleSlotsRoute(req(`/x?fromDate=${day}&toDate=${day}`), ctx(imported.id)),
        )
      ).reason,
    ).toBe("services_not_in_catalogue");
  });

  test("payments and devices", async () => {
    as("owner", w.staffId);
    pay.location.mockReturnValue("tml_1");
    pay.token.mockResolvedValue({ secret: "pst_1" });
    pay.start.mockResolvedValue({
      paymentId: "11111111-1111-4111-8111-111111111111",
      paymentIntentId: "pi_1",
      clientSecret: "pi_1_secret",
      amountCents: 4750,
    });
    pay.status.mockResolvedValue({
      status: "pending",
      bookingStatus: "confirmed",
      balanceDueCents: 4750,
    });
    await conforms("terminalConfig", await terminalConfig(req("/x")));
    await conforms("connectionToken", await connectionToken(req("/x", {})));
    await conforms("startCardPayment", await cardStart(req("/x", {}), ctx(mine)));
    await conforms(
      "cardPaymentStatus",
      await cardStatus(req("/x?paymentId=11111111-1111-4111-8111-111111111111"), ctx(mine)),
    );
    await conforms(
      "registerDevice",
      await addDevice(req("/x", { token: "ExponentPushToken[abc123]" })),
    );
    await conforms(
      "removeDevice",
      await removeDevice(
        new Request(`${ORIGIN}/api/v1/devices`, {
          method: "DELETE",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ token: "ExponentPushToken[abc123]" }),
        }),
      ),
    );
  });

  test("an error response matches the documented error shape", async () => {
    const { errorResponse } = await import("@/server/api/contract");
    state.viewer = null;
    const res = await getMe();
    expect(res.status).toBe(401);
    expect(errorResponse.safeParse(await res.json()).success).toBe(true);
    as("owner", w.staffId);
    const bad = await createBooking(req("/x", {}));
    expect(bad.status).toBe(422);
    expect(errorResponse.safeParse(await bad.json()).success).toBe(true);
  });
});
