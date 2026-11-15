import { describe, expect, test } from "vitest";
import {
  describeLevels,
  effectivePricing,
  effectivePricingFromDraft,
  formatDelta,
} from "@/server/admin-foundation/catalog-pricing";
import { priceFor } from "@/server/pricing";

const service = { priceCents: 9500, durationMin: 45 };
const alex = { id: "s-alex", name: "Alex", level: 0 };
const bea = { id: "s-bea", name: "Bea", level: 1 };
const cy = { id: "s-cy", name: "Cy", level: 2 };

describe("effectivePricing", () => {
  test("a stylist with nothing set inherits the service price and says so", () => {
    const [row] = effectivePricing(
      service,
      [{ staffId: alex.id, priceCents: null, durationMin: null }],
      [],
      [alex],
    );
    expect(row).toMatchObject({
      staffId: alex.id,
      priceCents: 9500,
      durationMin: 45,
      priceSource: "service",
      durationSource: "service",
      priceDeltaCents: 0,
      durationDeltaMin: 0,
      warnings: [],
    });
  });

  test("the level price applies to everyone at that level", () => {
    const rows = effectivePricing(
      service,
      [
        { staffId: alex.id, priceCents: null, durationMin: null },
        { staffId: bea.id, priceCents: null, durationMin: null },
      ],
      [{ level: 1, priceCents: 7500, durationMin: 60 }],
      [alex, bea],
    );
    expect(rows.map((r) => [r.name, r.priceCents, r.durationMin, r.priceSource])).toEqual([
      ["Alex", 9500, 45, "service"],
      ["Bea", 7500, 60, "level"],
    ]);
    expect(rows[1]).toMatchObject({ priceDeltaCents: -2000, durationDeltaMin: 15 });
  });

  test("a stylist override beats the level, field by field", () => {
    const [row] = effectivePricing(
      service,
      [{ staffId: bea.id, priceCents: 8000, durationMin: null }],
      [{ level: 1, priceCents: 7500, durationMin: 60 }],
      [bea],
    );
    expect(row).toMatchObject({
      priceCents: 8000,
      priceSource: "stylist",
      durationMin: 60,
      durationSource: "level",
    });
  });

  test("agrees with priceFor, the single source of truth", () => {
    const offering = { staffId: cy.id, priceCents: null, durationMin: 50 };
    const level = { level: 2, priceCents: 11000, durationMin: null };
    const [row] = effectivePricing(service, [offering], [level], [cy]);
    expect(row).toMatchObject(priceFor(service, offering, level));
  });

  test("lists only stylists who offer the service, sorted by name", () => {
    const rows = effectivePricing(
      service,
      [
        { staffId: cy.id, priceCents: null, durationMin: null },
        { staffId: alex.id, priceCents: null, durationMin: null },
        { staffId: "ghost", priceCents: null, durationMin: null },
      ],
      [],
      [cy, bea, alex],
    );
    expect(rows.map((r) => r.name)).toEqual(["Alex", "Cy"]);
  });

  test("warns about a free price so a typo is obvious", () => {
    const [row] = effectivePricing(
      service,
      [{ staffId: alex.id, priceCents: 0, durationMin: null }],
      [],
      [alex],
    );
    expect(row.warnings).toEqual(["Price is $0"]);
  });

  test("warns when a stylist is more than double the service price", () => {
    const [row] = effectivePricing(
      service,
      [{ staffId: alex.id, priceCents: 19100, durationMin: null }],
      [],
      [alex],
    );
    expect(row.warnings).toEqual(["More than double the service price"]);
  });
});

describe("describeLevels", () => {
  test("one row per level in use, lowest first, with who is on it", () => {
    const rows = describeLevels([cy, alex, bea, { id: "s-dee", name: "Dee", level: 1 }], []);
    expect(rows).toEqual([
      { level: 0, staffNames: ["Alex"], unused: false },
      { level: 1, staffNames: ["Bea", "Dee"], unused: false },
      { level: 2, staffNames: ["Cy"], unused: false },
    ]);
  });

  test("keeps a saved level that nobody holds any more, flagged unused", () => {
    const rows = describeLevels([alex], [{ level: 3, priceCents: 5000, durationMin: null }]);
    expect(rows).toEqual([
      { level: 0, staffNames: ["Alex"], unused: false },
      { level: 3, staffNames: [], unused: true },
    ]);
  });

  test("is empty when there are no stylists and no saved rows", () => {
    expect(describeLevels([], [])).toEqual([]);
  });
});

describe("effectivePricingFromDraft", () => {
  const staff = [alex, bea];
  const off = { offered: false, price: "", durationMin: "" };
  const on = { offered: true, price: "", durationMin: "" };
  const draft = {
    price: "100",
    durationMin: "50",
    offerings: { [alex.id]: on, [bea.id]: on },
    levels: { 0: { price: "", durationMin: "" }, 1: { price: "80", durationMin: "55" } },
  };

  test("resolves typed values the way saving would", () => {
    const rows = effectivePricingFromDraft(draft, service, staff);
    expect(rows.map((r) => [r.name, r.priceCents, r.durationMin])).toEqual([
      ["Alex", 10000, 50],
      ["Bea", 8000, 55],
    ]);
  });

  test("skips stylists who are not ticked as offering it", () => {
    const rows = effectivePricingFromDraft(
      { ...draft, offerings: { [alex.id]: on, [bea.id]: off } },
      service,
      staff,
    );
    expect(rows.map((r) => r.name)).toEqual(["Alex"]);
  });

  test("treats half-typed values as inherit and falls back to the saved service", () => {
    const rows = effectivePricingFromDraft(
      {
        price: "",
        durationMin: "abc",
        offerings: { [alex.id]: { offered: true, price: "9x", durationMin: "-3" } },
        levels: {},
      },
      service,
      staff,
    );
    expect(rows[0]).toMatchObject({ priceCents: 9500, durationMin: 45 });
  });

  test("a stylist's own typed price beats the level", () => {
    const rows = effectivePricingFromDraft(
      { ...draft, offerings: { [bea.id]: { offered: true, price: "70", durationMin: "" } } },
      service,
      staff,
    );
    expect(rows[0]).toMatchObject({ priceCents: 7000, priceSource: "stylist", durationMin: 55 });
  });
});

describe("formatDelta", () => {
  test("shows signed dollars and minutes, blank when unchanged", () => {
    expect(formatDelta(1000, "money")).toBe("+$10.00");
    expect(formatDelta(-2000, "money")).toBe("-$20.00");
    expect(formatDelta(0, "money")).toBe("");
    expect(formatDelta(15, "minutes")).toBe("+15 min");
    expect(formatDelta(-5, "minutes")).toBe("-5 min");
    expect(formatDelta(0, "minutes")).toBe("");
  });
});
