import { describe, expect, it } from "vitest";
import {
  canLeaveStep,
  canVisit,
  chosenStaffId,
  flowReducer,
  flowTotals,
  initialStateFor,
  isEstimate,
  selectedStaffName,
  stepsFor,
  staffStepOptions,
  type FlowAction,
} from "@/components/public/flow/state";
import { createApiClient } from "@/components/public/flow/api-client";
import { buildHoldRequest, EMPTY_DETAILS } from "@/components/public/flow/details";
import type { CatalogData, SlotDto } from "@/lib/public-api-types";
import { STAFF_ALEX, STAFF_BEA, SVC_BEARD, SVC_CUT, catalog, staffCatalog } from "./fakes";

const slot: SlotDto = {
  start: "2026-11-20T03:30:00Z",
  end: "2026-11-20T04:15:00Z",
  label: "2:30 pm",
};

const run = (data: CatalogData, ...actions: FlowAction[]) =>
  actions.reduce(flowReducer, initialStateFor(data));

const pickCut: FlowAction = { type: "toggleService", serviceId: SVC_CUT };

describe("the stylist step in the step list", () => {
  it("does not exist when clients cannot choose, so nothing changes", () => {
    expect(stepsFor(catalog, run(catalog, pickCut))).toEqual([
      "services",
      "time",
      "details",
      "pay",
    ]);
  });

  it("sits between services and time when choosing is on and there is a choice", () => {
    expect(stepsFor(staffCatalog, run(staffCatalog, pickCut))).toEqual([
      "services",
      "staff",
      "time",
      "details",
      "pay",
    ]);
  });

  it("is present before any service is picked, so the rail does not change as they choose", () => {
    expect(stepsFor(staffCatalog, run(staffCatalog))).toContain("staff");
  });

  it("is skipped when a location has fewer than two stylists to choose between", () => {
    const one: CatalogData = {
      ...staffCatalog,
      locations: staffCatalog.locations.map((l) => ({ ...l, staff: l.staff.slice(0, 1) })),
    };
    expect(stepsFor(one, run(one, pickCut))).not.toContain("staff");
  });

  it("with several locations, appears from the start if any has a choice, then follows the chosen one", () => {
    const [first] = staffCatalog.locations;
    const second = { ...first, id: "other", name: "Southside", staff: [] };
    const multi: CatalogData = { ...staffCatalog, locations: [first, second] };
    expect(stepsFor(multi, initialStateFor(multi))).toContain("staff");
    const atSecond = flowReducer(initialStateFor(multi), {
      type: "selectLocation",
      locationId: "other",
    });
    expect(stepsFor(multi, atSecond)).not.toContain("staff");
  });

  it("can always be left (Anyone is the default) and visited once services are chosen", () => {
    const state = run(staffCatalog, pickCut);
    expect(canLeaveStep(state, "staff")).toBe(true);
    const steps = stepsFor(staffCatalog, state);
    expect(canVisit({ ...state, step: "time" }, steps, "staff")).toBe(true);
  });
});

describe("choosing a stylist", () => {
  it("defaults to Anyone and remembers a pick", () => {
    expect(run(staffCatalog, pickCut).staffId).toBeNull();
    const state = run(staffCatalog, pickCut, { type: "pickStaff", staffId: STAFF_BEA });
    expect(chosenStaffId(state, staffCatalog)).toBe(STAFF_BEA);
  });

  it("clears the picked time, because availability is per stylist", () => {
    const state = run(
      staffCatalog,
      pickCut,
      { type: "pickDate", date: "2026-11-20" },
      { type: "pickSlot", slot },
      { type: "pickStaff", staffId: STAFF_ALEX },
    );
    expect(state.slot).toBeNull();
    expect(state.date).toBeNull();
  });

  it("does not clear anything when the same choice is made again", () => {
    const state = run(
      staffCatalog,
      pickCut,
      { type: "pickStaff", staffId: STAFF_ALEX },
      { type: "pickSlot", slot },
      { type: "pickStaff", staffId: STAFF_ALEX },
    );
    expect(state.slot).toEqual(slot);
  });

  it("forgets the stylist when they can no longer do the selection", () => {
    const state = run(
      staffCatalog,
      pickCut,
      { type: "pickStaff", staffId: STAFF_BEA },
      { type: "toggleService", serviceId: SVC_BEARD },
    );
    expect(state.staffId).toBe(STAFF_BEA);
    expect(chosenStaffId(state, staffCatalog)).toBeNull();
  });

  it("forgets the stylist when the location changes", () => {
    const state = run(
      staffCatalog,
      { type: "pickStaff", staffId: STAFF_BEA },
      { type: "selectLocation", locationId: "elsewhere" },
    );
    expect(state.staffId).toBeNull();
  });

  it("lists Anyone and the eligible stylists with their totals", () => {
    const options = staffStepOptions(run(staffCatalog, pickCut), staffCatalog);
    expect(options.map((o) => [o.id, o.quote.totalCents])).toEqual([
      [null, 7500],
      [STAFF_ALEX, 9500],
      [STAFF_BEA, 7500],
    ]);
    expect(options[0].showPrice).toBe(true);
  });

  it("is empty when choosing is off", () => {
    expect(staffStepOptions(run(catalog, pickCut), catalog)).toEqual([]);
  });
});

describe("totals follow the stylist", () => {
  it("are unchanged when choosing is off", () => {
    expect(flowTotals(run(catalog, pickCut), catalog)).toEqual({
      totalCents: 9500,
      durationMin: 45,
      depositCents: 4750,
    });
    expect(isEstimate(run(catalog, pickCut), catalog)).toBe(false);
  });

  it("with Anyone and differing prices show the lowest as an estimate", () => {
    const state = run(staffCatalog, pickCut);
    expect(flowTotals(state, staffCatalog)).toEqual({
      totalCents: 7500,
      durationMin: 60,
      depositCents: 3750,
    });
    expect(isEstimate(state, staffCatalog)).toBe(true);
  });

  it("with Anyone and equal prices are exact", () => {
    const state = run(staffCatalog, { type: "toggleService", serviceId: SVC_BEARD });
    expect(flowTotals(state, staffCatalog).totalCents).toBe(3000);
    expect(isEstimate(state, staffCatalog)).toBe(false);
  });

  it("for a chosen stylist are that stylist's price and time, exact", () => {
    const state = run(staffCatalog, pickCut, { type: "pickStaff", staffId: STAFF_BEA });
    expect(flowTotals(state, staffCatalog)).toMatchObject({ totalCents: 7500, durationMin: 60 });
    expect(isEstimate(state, staffCatalog)).toBe(false);
  });

  it("for Anyone with a picked time are the assigned stylist's price, exact", () => {
    const state = run(staffCatalog, pickCut, {
      type: "pickSlot",
      slot: { ...slot, staffId: STAFF_ALEX, priceCents: 9500, durationMin: 45 },
    });
    expect(flowTotals(state, staffCatalog)).toMatchObject({ totalCents: 9500, durationMin: 45 });
    expect(isEstimate(state, staffCatalog)).toBe(false);
  });
});

describe("naming the stylist", () => {
  it("is the chosen stylist, else the one the picked slot is with, else nobody", () => {
    expect(selectedStaffName(run(staffCatalog, pickCut), staffCatalog)).toBeNull();
    const asked = run(staffCatalog, pickCut, { type: "pickStaff", staffId: STAFF_BEA });
    expect(selectedStaffName(asked, staffCatalog)).toBe("Bea");
    const anyone = run(staffCatalog, pickCut, {
      type: "pickSlot",
      slot: { ...slot, staffId: STAFF_ALEX, priceCents: 9500, durationMin: 45 },
    });
    expect(selectedStaffName(anyone, staffCatalog)).toBe("Alex");
  });

  it("is nobody when choosing is off", () => {
    const state = run(catalog, pickCut, {
      type: "pickSlot",
      slot: { ...slot, staffId: STAFF_ALEX },
    });
    expect(selectedStaffName(state, catalog)).toBeNull();
  });
});

describe("requests", () => {
  it("availability sends the chosen stylist", async () => {
    const calls: string[] = [];
    const api = createApiClient(async (url) => {
      calls.push(String(url));
      return new Response(JSON.stringify({ success: true, data: {} }));
    });
    await api.availability({
      locationId: "l",
      serviceIds: ["a"],
      fromDate: "2026-11-01",
      toDate: "2026-11-30",
      staffId: STAFF_BEA,
    });
    await api.availability({
      locationId: "l",
      serviceIds: ["a"],
      fromDate: "2026-11-01",
      toDate: "2026-11-30",
    });
    expect(calls[0]).toContain(`staffId=${STAFF_BEA}`);
    expect(calls[1]).not.toContain("staffId");
  });

  it("the hold request carries the stylist and whether they were asked for", () => {
    const base = {
      locationId: "l",
      serviceIds: ["a"],
      slotStart: slot.start,
      details: { ...EMPTY_DETAILS, policyAccepted: true },
      policyVersion: "1",
    };
    expect(buildHoldRequest({ ...base, staffId: STAFF_BEA, staffRequested: true })).toMatchObject({
      staffId: STAFF_BEA,
      staffRequested: true,
    });
    const anyone = buildHoldRequest(base);
    expect(anyone.staffId).toBeUndefined();
    expect(anyone.staffRequested).toBe(false);
  });
});
