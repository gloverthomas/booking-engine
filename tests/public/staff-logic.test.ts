import { describe, expect, it } from "vitest";
import {
  baseQuote,
  eligibleStaff,
  initialsOf,
  quoteFor,
  quoteRange,
  serviceRange,
  staffOptions,
} from "@/lib/public-api-staff";
import type { CatalogService, CatalogStaff } from "@/lib/public-api-types";

const svc = (id: string, priceCents: number, durationMin: number, depositPct = 50): CatalogService => ({
  id,
  name: `Service ${id}`,
  description: null,
  category: null,
  durationMin,
  priceCents,
  depositPct,
  intakeQuestions: [],
});

const cut = svc("cut", 9500, 45);
const beard = svc("beard", 3000, 15);

const alex: CatalogStaff = {
  id: "alex",
  name: "Alex",
  offers: { cut: { priceCents: 9500, durationMin: 45 }, beard: { priceCents: 3000, durationMin: 15 } },
};
const bea: CatalogStaff = {
  id: "bea",
  name: "Bea",
  offers: { cut: { priceCents: 7500, durationMin: 60 } },
};
const cy: CatalogStaff = {
  id: "cy",
  name: "Cy",
  offers: { cut: { priceCents: 9500, durationMin: 45 }, beard: { priceCents: 3000, durationMin: 15 } },
};

describe("eligibleStaff", () => {
  it("keeps only stylists who offer every selected service", () => {
    expect(eligibleStaff([alex, bea, cy], ["cut"]).map((s) => s.id)).toEqual(["alex", "bea", "cy"]);
    expect(eligibleStaff([alex, bea, cy], ["cut", "beard"]).map((s) => s.id)).toEqual([
      "alex",
      "cy",
    ]);
  });

  it("returns nobody when no one offers the combination, and everyone for no selection", () => {
    expect(eligibleStaff([bea], ["cut", "beard"])).toEqual([]);
    expect(eligibleStaff([alex, bea], [])).toHaveLength(2);
  });
});

describe("quoteFor", () => {
  it("totals that stylist's own prices, times and deposit", () => {
    const quote = quoteFor(alex, [cut, beard]);
    expect(quote).toMatchObject({ totalCents: 12500, durationMin: 60, depositCents: 6250 });
    expect(quote?.lines.map((l) => l.id)).toEqual(["cut", "beard"]);
  });

  it("uses the stylist's price for the deposit too", () => {
    expect(quoteFor(bea, [cut])).toMatchObject({
      totalCents: 7500,
      durationMin: 60,
      depositCents: 3750,
    });
  });

  it("respects a per-service deposit percentage", () => {
    const quote = quoteFor(alex, [svc("cut", 9500, 45, 100), beard]);
    expect(quote?.depositCents).toBe(9500 + 1500);
  });

  it("is null when the stylist does not offer one of the services", () => {
    expect(quoteFor(bea, [cut, beard])).toBeNull();
  });
});

describe("baseQuote", () => {
  it("is the plain service total, the same as before stylists existed", () => {
    expect(baseQuote([cut, beard])).toMatchObject({
      totalCents: 12500,
      durationMin: 60,
      depositCents: 6250,
    });
    expect(baseQuote([])).toMatchObject({ totalCents: 0, durationMin: 0, depositCents: 0 });
  });
});

describe("quoteRange", () => {
  it("reports the cheapest and dearest and whether they differ", () => {
    const range = quoteRange([alex, bea, cy], [cut]);
    expect(range?.low.totalCents).toBe(7500);
    expect(range?.high.totalCents).toBe(9500);
    expect(range?.differs).toBe(true);
  });

  it("differs when only the time differs", () => {
    const slow: CatalogStaff = { ...bea, offers: { cut: { priceCents: 9500, durationMin: 60 } } };
    expect(quoteRange([alex, slow], [cut])?.differs).toBe(true);
  });

  it("does not differ when everyone charges the same", () => {
    expect(quoteRange([alex, cy], [cut, beard])?.differs).toBe(false);
  });

  it("is null when no stylist can do the selection", () => {
    expect(quoteRange([bea], [cut, beard])).toBeNull();
    expect(quoteRange([], [cut])).toBeNull();
  });
});

describe("serviceRange", () => {
  it("gives the lowest and highest price across stylists who offer that service", () => {
    expect(serviceRange([alex, bea, cy], "cut")).toEqual({ minCents: 7500, maxCents: 9500 });
    expect(serviceRange([alex, bea], "beard")).toEqual({ minCents: 3000, maxCents: 3000 });
  });

  it("is null when nobody offers it", () => {
    expect(serviceRange([bea], "beard")).toBeNull();
  });
});

describe("staffOptions", () => {
  it("puts 'Anyone available' first, then each eligible stylist by name", () => {
    const options = staffOptions([cy, bea, alex], [cut]);
    expect(options.map((o) => o.id)).toEqual([null, "alex", "bea", "cy"]);
    expect(options[0].name).toBe("Anyone available");
  });

  it("shows prices only when they differ between stylists", () => {
    const differing = staffOptions([alex, bea], [cut]);
    expect(differing[0]).toMatchObject({ showPrice: true, fromPrefix: true });
    expect(differing[0].quote.totalCents).toBe(7500);
    expect(differing.find((o) => o.id === "bea")).toMatchObject({ showPrice: true });

    const same = staffOptions([alex, cy], [cut]);
    expect(same.every((o) => !o.showPrice)).toBe(true);
    expect(same[0].fromPrefix).toBe(false);
  });

  it("leaves out stylists who cannot do the whole selection", () => {
    expect(staffOptions([alex, bea, cy], [cut, beard]).map((o) => o.id)).toEqual([
      null,
      "alex",
      "cy",
    ]);
  });

  it("offers only 'Anyone' with the base quote when no stylist qualifies", () => {
    const options = staffOptions([bea], [cut, beard]);
    expect(options).toHaveLength(1);
    expect(options[0].quote.totalCents).toBe(12500);
  });
});

describe("initialsOf", () => {
  it("takes up to two initials", () => {
    expect(initialsOf("Alex")).toBe("A");
    expect(initialsOf("Bea Jones")).toBe("BJ");
    expect(initialsOf("  ")).toBe("?");
  });
});
