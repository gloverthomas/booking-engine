import { describe, expect, test } from "vitest";
import { priceFor } from "@/server/pricing";

const base = { priceCents: 9500, durationMin: 45 };

describe("priceFor", () => {
  test("uses service defaults without an override", () => {
    expect(priceFor(base)).toEqual(base);
    expect(priceFor(base, null)).toEqual(base);
  });

  test("applies per-staff overrides field by field", () => {
    expect(priceFor(base, { priceCents: 12000, durationMin: null })).toEqual({
      priceCents: 12000,
      durationMin: 45,
    });
    expect(priceFor(base, { priceCents: null, durationMin: 60 })).toEqual({
      priceCents: 9500,
      durationMin: 60,
    });
  });
});
