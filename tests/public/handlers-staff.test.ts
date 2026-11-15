import { describe, expect, it, vi } from "vitest";
import { handleAvailability, handleCatalog, handleCreateHold } from "@/lib/public-api-handlers";
import { handleGetBooking } from "@/lib/public-api-handlers-booking";
import { parseSettings } from "@/server/settings";
import {
  LOC,
  STAFF_ALEX,
  STAFF_BEA,
  SVC_BEARD,
  SVC_CUT,
  TOKEN,
  catalog,
  get,
  makeBackend,
  makeDeps,
  post,
  staffCatalog,
  validHoldBody,
} from "./fakes";

async function json(res: Response) {
  return (await res.json()) as {
    success: boolean;
    data?: Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    error?: { code: string; message: string };
  };
}

const settingsOn = (over: Record<string, unknown> = {}) =>
  parseSettings({ policyVersion: "1", chooseStaff: true, ...over });

const depsWithStaff = (over: Parameters<typeof makeDeps>[0] = {}) =>
  makeDeps({
    loadBusiness: async () => ({
      id: "biz",
      name: "Ryan Kennedy Hairdressing",
      timezone: "Australia/Melbourne",
      settings: settingsOn(),
    }),
    loadCatalog: async () => staffCatalog,
    ...over,
  });

const slot = (staffId: string, iso = "2026-11-20T03:30:00Z") => ({
  staffId,
  start: new Date(iso),
  end: new Date(new Date(iso).getTime() + 45 * 60_000),
});

describe("GET /catalog", () => {
  it("passes the stylist list and the two settings through", async () => {
    const res = await handleCatalog(depsWithStaff(), get("http://localhost/api/public/catalog"));
    const { data } = await json(res);
    expect(data).toMatchObject({ chooseStaff: true, waitlistEnabled: true });
    expect(data?.locations[0].staff.map((s: { name: string }) => s.name)).toEqual(["Alex", "Bea"]);
  });
});

describe("GET /availability with stylists", () => {
  const url = (extra = "", services = SVC_CUT) =>
    `http://localhost/api/public/availability?locationId=${LOC}&serviceIds=${services}&fromDate=2026-11-01&toDate=2026-11-30${extra}`;

  it("passes a chosen stylist to the backend", async () => {
    const backend = makeBackend({ getAvailableSlots: vi.fn(async () => [slot(STAFF_BEA)]) });
    await handleAvailability(depsWithStaff({ backend }), get(url(`&staffId=${STAFF_BEA}`)));
    expect(backend.getAvailableSlots).toHaveBeenCalledWith(
      expect.objectContaining({ staffId: STAFF_BEA }),
    );
  });

  it("labels each slot with its stylist and that stylist's total and time", async () => {
    const backend = makeBackend({
      getAvailableSlots: vi.fn(async () => [
        slot(STAFF_ALEX, "2026-11-20T01:00:00Z"),
        slot(STAFF_BEA, "2026-11-20T03:30:00Z"),
      ]),
    });
    const res = await handleAvailability(depsWithStaff({ backend }), get(url()));
    const { data } = await json(res);
    const [day] = data?.days;
    expect([...day.morning, ...day.afternoon]).toEqual([
      expect.objectContaining({ staffId: STAFF_ALEX, priceCents: 9500, durationMin: 45 }),
      expect.objectContaining({ staffId: STAFF_BEA, priceCents: 7500, durationMin: 60 }),
    ]);
  });

  it("adds up several services for the slot's stylist", async () => {
    const backend = makeBackend({ getAvailableSlots: vi.fn(async () => [slot(STAFF_ALEX)]) });
    const res = await handleAvailability(
      depsWithStaff({ backend }),
      get(url("", `${SVC_CUT},${SVC_BEARD}`)),
    );
    const { data } = await json(res);
    expect(data?.days[0].afternoon[0]).toMatchObject({ priceCents: 12500, durationMin: 60 });
  });

  it("adds nothing to slots when choosing a stylist is off", async () => {
    const backend = makeBackend({ getAvailableSlots: vi.fn(async () => [slot(STAFF_ALEX)]) });
    const res = await handleAvailability(
      makeDeps({ backend, loadCatalog: async () => catalog }),
      get(url()),
    );
    const { data } = await json(res);
    expect(data?.days[0].afternoon[0]).not.toHaveProperty("staffId");
    expect(data?.days[0].afternoon[0]).not.toHaveProperty("priceCents");
  });

  it("still passes a stylist through when choosing is off (a reschedule stays with its stylist)", async () => {
    const backend = makeBackend();
    await handleAvailability(makeDeps({ backend }), get(url(`&staffId=${STAFF_ALEX}`)));
    expect(backend.getAvailableSlots).toHaveBeenCalledWith(
      expect.objectContaining({ staffId: STAFF_ALEX }),
    );
  });

  it("leaves a slot unlabelled when its stylist is not in the catalog", async () => {
    const backend = makeBackend({
      getAvailableSlots: vi.fn(async () => [slot("99999999-9999-4999-8999-999999999999")]),
    });
    const res = await handleAvailability(depsWithStaff({ backend }), get(url()));
    const { data } = await json(res);
    expect(data?.days[0].afternoon[0]).not.toHaveProperty("priceCents");
  });
});

describe("POST /holds with stylists", () => {
  it("passes a requested stylist and flags it as requested", async () => {
    const backend = makeBackend();
    const res = await handleCreateHold(
      depsWithStaff({ backend }),
      post({ ...validHoldBody, staffId: STAFF_BEA, staffRequested: true }),
    );
    expect(res.status).toBe(201);
    expect(backend.createHold).toHaveBeenCalledWith(
      expect.objectContaining({ staffId: STAFF_BEA, staffRequested: true }),
    );
  });

  it("pins the quoted stylist for 'anyone' without marking them as requested", async () => {
    const backend = makeBackend();
    await handleCreateHold(
      depsWithStaff({ backend }),
      post({ ...validHoldBody, staffId: STAFF_ALEX }),
    );
    expect(backend.createHold).toHaveBeenCalledWith(
      expect.objectContaining({ staffId: STAFF_ALEX, staffRequested: false }),
    );
  });

  it("sends no stylist when none was chosen", async () => {
    const backend = makeBackend();
    await handleCreateHold(depsWithStaff({ backend }), post(validHoldBody));
    expect(backend.createHold).toHaveBeenCalledWith(
      expect.objectContaining({ staffId: undefined, staffRequested: false }),
    );
  });

  it("rejects a stylist who does not offer every selected service", async () => {
    const backend = makeBackend();
    const res = await handleCreateHold(
      depsWithStaff({ backend }),
      post({
        ...validHoldBody,
        serviceIds: [SVC_CUT, SVC_BEARD],
        intakeAnswers: { q1: "Short" },
        staffId: STAFF_BEA,
        staffRequested: true,
      }),
    );
    expect(res.status).toBe(422);
    expect((await json(res)).error?.code).toBe("invalid_selection");
    expect(backend.createHold).not.toHaveBeenCalled();
  });

  it("rejects a stylist who is not at this location", async () => {
    const res = await handleCreateHold(
      depsWithStaff(),
      post({ ...validHoldBody, staffId: "99999999-9999-4999-8999-999999999999" }),
    );
    expect(res.status).toBe(422);
  });

  it("ignores a stylist when choosing is off, so nothing changes for the client", async () => {
    const backend = makeBackend();
    await handleCreateHold(
      makeDeps({ backend }),
      post({ ...validHoldBody, staffId: STAFF_BEA, staffRequested: true }),
    );
    expect(backend.createHold).toHaveBeenCalledWith(
      expect.objectContaining({ staffId: undefined, staffRequested: false }),
    );
  });
});

describe("GET /bookings/[token] with stylists", () => {
  const url = "http://localhost/api/public/bookings/x";

  it("always returns the booking's stylist id so a reschedule stays with them", async () => {
    const { data } = await json(await handleGetBooking(makeDeps(), get(url), TOKEN));
    expect(data).toMatchObject({ staffId: STAFF_ALEX, staffName: null });
  });

  it("shows the stylist's name when clients may choose", async () => {
    const { data } = await json(await handleGetBooking(depsWithStaff(), get(url), TOKEN));
    expect(data).toMatchObject({ staffId: STAFF_ALEX, staffName: "Alex" });
  });

  it("shows the name of a stylist the client asked for even when choosing is now off", async () => {
    const deps = makeDeps({
      loadBookingContext: async () => ({
        locationId: LOC,
        locationName: "Northside",
        address: null,
        arrivalNote: null,
        phone: null,
        serviceIds: [SVC_CUT],
        staffId: STAFF_BEA,
        staffName: "Bea",
        staffRequested: true,
      }),
    });
    const { data } = await json(await handleGetBooking(deps, get(url), TOKEN));
    expect(data).toMatchObject({ staffId: STAFF_BEA, staffName: "Bea" });
  });
});
