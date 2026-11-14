import { describe, expect, test } from "vitest";
import { computeCheckout } from "@/server/admin/checkout-math";

const settings = (cashDiscountPct: number) => ({ cashDiscountPct });

describe("computeCheckout", () => {
  test("balance due is total minus paid with no discount", () => {
    const r = computeCheckout({ totalCents: 20000, paidCents: 10000 }, settings(0), "cash");
    expect(r).toEqual({
      totalCents: 20000,
      paidCents: 10000,
      balanceDueCents: 10000,
      cashDiscountCents: 0,
      payableCents: 10000,
    });
  });

  test("cash discount applies to the balance for cash only", () => {
    const cash = computeCheckout({ totalCents: 20000, paidCents: 10000 }, settings(10), "cash");
    expect(cash.cashDiscountCents).toBe(1000);
    expect(cash.payableCents).toBe(9000);

    for (const method of ["eftpos", "other"] as const) {
      const r = computeCheckout({ totalCents: 20000, paidCents: 10000 }, settings(10), method);
      expect(r.cashDiscountCents).toBe(0);
      expect(r.payableCents).toBe(10000);
    }
  });

  test("discount rounds to whole cents", () => {
    // 3333 * 5% = 166.65 -> 167
    const r = computeCheckout({ totalCents: 3333, paidCents: 0 }, settings(5), "cash");
    expect(r.cashDiscountCents).toBe(167);
    expect(r.payableCents).toBe(3166);
  });

  test("never goes below zero when already fully paid or overpaid", () => {
    const paid = computeCheckout({ totalCents: 9500, paidCents: 9500 }, settings(10), "cash");
    expect(paid.balanceDueCents).toBe(0);
    expect(paid.cashDiscountCents).toBe(0);
    expect(paid.payableCents).toBe(0);

    const over = computeCheckout({ totalCents: 9500, paidCents: 12000 }, settings(10), "cash");
    expect(over.balanceDueCents).toBe(0);
    expect(over.payableCents).toBe(0);
  });

  test("a 100% discount clears the balance and cannot exceed it", () => {
    const r = computeCheckout({ totalCents: 5000, paidCents: 0 }, settings(100), "cash");
    expect(r.cashDiscountCents).toBe(5000);
    expect(r.payableCents).toBe(0);
  });
});
