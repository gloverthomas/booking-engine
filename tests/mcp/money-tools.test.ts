import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { and, eq } from "drizzle-orm";
import { auditLog, booking, client, payment } from "@/db/schema";
import { loadMcpConfig } from "@/server/mcp/config";
import { createHarness, type Harness } from "./harness";

let h: Harness;
let call: Awaited<ReturnType<Harness["connect"]>>["call"];
let close: () => Promise<void>;
let day = 0;

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
  // One database for the whole file. Every test gets its own business day (so daily totals start at zero),
  // default caps, the switch on, and fresh mocks.
  day += 1;
  h.clock.now = new Date(Date.UTC(2026, 10, 14 + 3 * day, 1));
  Object.assign(h.deps.config, loadMcpConfig({}), { moneyToolsEnabled: true });
  for (const fn of Object.values(h.services)) fn.mockClear();
});

async function twoStep(name: string, args: Record<string, unknown>) {
  const preview = await call(name, args);
  const executed = preview.isError
    ? preview
    : await call(name, { ...args, confirmToken: preview.body.confirmToken });
  return { preview, executed };
}

/** A succeeded deposit of the given size on b7 (Jo, confirmed). */
async function depositOf(amountCents: number, bookingId = h.fx.bookings.b7) {
  const [row] = await h.t.db
    .insert(payment)
    .values({
      bookingId,
      kind: "deposit",
      method: "stripe_online",
      status: "succeeded",
      amountCents,
    })
    .returning({ id: payment.id });
  return row.id;
}

const auditsFor = async (action: string, entityId: string) =>
  (await h.t.db.select().from(auditLog).where(eq(auditLog.action, action))).filter(
    (r) => r.entityId === entityId,
  );
const countAudits = async (action: string) =>
  (await h.t.db.select().from(auditLog).where(eq(auditLog.action, action))).length;

describe("kill switch", () => {
  beforeEach(() => {
    h.deps.config.moneyToolsEnabled = false;
  });

  test("money tools are off unless the operator turns them on: no preview, no refund, no fee", async () => {
    const id = await depositOf(4750);
    const refund = await call("refund_payment", { paymentId: id });
    expect(refund.isError).toBe(true);
    expect(refund.body.error.code).toBe("money_tools_disabled");
    expect(refund.body.confirmToken).toBeUndefined();
    const fee = await call("charge_no_show_fee", {
      bookingId: h.fx.bookings.b3,
      amountCents: 1000,
      kind: "late_cancel_fee",
    });
    expect(fee.body.error.code).toBe("money_tools_disabled");
    expect(h.services.refundPayment).not.toHaveBeenCalled();
    expect(h.services.chargeSavedCard).not.toHaveBeenCalled();
  });

  test("the default configuration has them off", () => {
    expect(loadMcpConfig({}).moneyToolsEnabled).toBe(false);
  });

  test("a token minted while the tools were on cannot be used once they are off", async () => {
    const id = await depositOf(4750);
    h.deps.config.moneyToolsEnabled = true;
    const preview = await call("refund_payment", { paymentId: id });
    expect(preview.body.status).toBe("confirmation_required");
    h.deps.config.moneyToolsEnabled = false; // operator flips the switch between the two steps
    const executed = await call("refund_payment", {
      paymentId: id,
      confirmToken: preview.body.confirmToken,
    });
    expect(executed.body.error.code).toBe("money_tools_disabled");
    expect(h.services.refundPayment).not.toHaveBeenCalled();
  });

  test("the status tool reports the switch", async () => {
    const r = await call("get_integration_status", {});
    expect(r.body.mcp.moneyToolsEnabled).toBe(false);
  });
});

describe("refund_payment", () => {
  test("previews exact amount and recipient, then refunds through the payments module and audits it", async () => {
    const id = await depositOf(4750);
    const { preview, executed } = await twoStep("refund_payment", { paymentId: id });
    expect(preview.body.preview.summary).toContain("REFUND $47.50 of a $47.50 deposit");
    expect(preview.body.preview.summary).toContain('"Jo Chen"');
    expect(preview.body.preview.details).toMatchObject({
      refundAmountCents: 4750,
      spentTodayCents: 0,
      remainingTodayCents: 50000,
    });
    expect(h.services.refundPayment).toHaveBeenCalledTimes(1);
    expect(h.services.refundPayment).toHaveBeenCalledWith(h.t.db, id, 4750);
    expect(executed.body.result).toEqual({ paymentId: id, refundedCents: 4750 });
    const [row] = await auditsFor("mcp.refund_payment", id);
    expect(row).toMatchObject({ actor: "mcp", entityType: "payment" });
    expect(row.data).toMatchObject({ amountCents: 4750 });
    expect(await countAudits("mcp.money.reserve")).toBeGreaterThanOrEqual(1);
  });

  test("a partial refund moves only the stated amount", async () => {
    const id = await depositOf(4750);
    const { preview } = await twoStep("refund_payment", { paymentId: id, amountCents: 1500 });
    expect(preview.body.preview.summary).toContain("REFUND $15.00 of a $47.50 deposit");
    expect(h.services.refundPayment).toHaveBeenCalledWith(h.t.db, id, 1500);
  });

  test("the confirm token is bound to the amount", async () => {
    const id = await depositOf(4750);
    const preview = await call("refund_payment", { paymentId: id, amountCents: 1000 });
    const bigger = await call("refund_payment", {
      paymentId: id,
      amountCents: 4750,
      confirmToken: preview.body.confirmToken,
    });
    expect(bigger.body.error.code).toBe("confirm_token_invalid");
    expect(h.services.refundPayment).not.toHaveBeenCalled();
  });

  test("a confirmed refund cannot be replayed to refund twice", async () => {
    const id = await depositOf(4750);
    const { preview } = await twoStep("refund_payment", { paymentId: id });
    const replay = await call("refund_payment", {
      paymentId: id,
      confirmToken: preview.body.confirmToken,
    });
    expect(replay.body.error.code).toBe("confirm_token_used");
    expect(h.services.refundPayment).toHaveBeenCalledTimes(1);
  });

  test("only refundable payments and sensible amounts", async () => {
    const id = await depositOf(4750);
    expect(
      (await call("refund_payment", { paymentId: id, amountCents: 4751 })).body.error.code,
    ).toBe("invalid_input");
    expect((await call("refund_payment", { paymentId: id, amountCents: 0 })).body.error.code).toBe(
      "invalid_input",
    );
    expect((await call("refund_payment", { paymentId: id, amountCents: -5 })).body.error.code).toBe(
      "invalid_input",
    );
    expect(
      (await call("refund_payment", { paymentId: id, amountCents: 12.5 })).body.error.code,
    ).toBe("invalid_input");
    expect(
      (await call("refund_payment", { paymentId: "00000000-0000-4000-8000-000000000000" })).body
        .error.code,
    ).toBe("not_found");
    const [refundRow] = await h.t.db
      .select()
      .from(payment)
      .where(and(eq(payment.kind, "refund")));
    expect((await call("refund_payment", { paymentId: refundRow.id })).body.error.code).toBe(
      "precondition_failed",
    );
    const [pending] = await h.t.db.select().from(payment).where(eq(payment.status, "pending"));
    expect((await call("refund_payment", { paymentId: pending.id })).body.error.message).toMatch(
      /pending/,
    );
    expect(h.services.refundPayment).not.toHaveBeenCalled();
  });

  test("enforces the per-call cap", async () => {
    const id = await depositOf(30000);
    const over = await call("refund_payment", { paymentId: id });
    expect(over.body.error).toMatchObject({
      code: "amount_exceeds_per_call_cap",
      details: { perCallCapCents: 20000 },
    });
    const atCap = await call("refund_payment", { paymentId: id, amountCents: 20000 });
    expect(atCap.body.status).toBe("confirmation_required");
  });

  test("a failed refund gives its allowance back and records the failure", async () => {
    const id = await depositOf(4750);
    h.services.refundPayment.mockRejectedValueOnce(new Error("Stripe said no"));
    const { executed } = await twoStep("refund_payment", { paymentId: id });
    expect(executed.body.error).toMatchObject({ code: "backend_error", message: "Stripe said no" });
    const status = await call("get_integration_status", {});
    expect(status.body.mcp.moneyUsedTodayCents).toBe(0);
    expect(await countAudits("mcp.refund_payment.failed")).toBeGreaterThanOrEqual(1);
    expect(await auditsFor("mcp.refund_payment", id)).toHaveLength(0);
  });
});

describe("daily cap", () => {
  beforeEach(() => {
    h.deps.config.maxMoneyCentsPerDay = 10000;
  });

  test("stops once the day's total is used, and resets at local midnight", async () => {
    const a = await depositOf(6000);
    const b = await depositOf(6000);
    expect((await twoStep("refund_payment", { paymentId: a })).executed.body.status).toBe(
      "executed",
    );
    const blocked = await call("refund_payment", { paymentId: b });
    expect(blocked.body.error).toMatchObject({
      code: "daily_cap_exceeded",
      details: { spentTodayCents: 6000, dailyCapCents: 10000 },
    });
    expect((await call("get_integration_status", {})).body.mcp).toMatchObject({
      moneyUsedTodayCents: 6000,
      moneyRemainingTodayCents: 4000,
    });
    // Same instant, but 25 hours later is the next business day.
    h.clock.now = new Date(h.clock.now.getTime() + 25 * 3_600_000);
    expect((await twoStep("refund_payment", { paymentId: b })).executed.body.status).toBe(
      "executed",
    );
  });

  test("two confirmations that each looked fine cannot together overshoot", async () => {
    const a = await depositOf(6000);
    const b = await depositOf(6000);
    const pa = await call("refund_payment", { paymentId: a });
    const pb = await call("refund_payment", { paymentId: b });
    expect(pa.body.status).toBe("confirmation_required");
    expect(pb.body.status).toBe("confirmation_required");
    const [ra, rb] = await Promise.all([
      call("refund_payment", { paymentId: a, confirmToken: pa.body.confirmToken }),
      call("refund_payment", { paymentId: b, confirmToken: pb.body.confirmToken }),
    ]);
    const outcomes = [ra, rb].map((r) => r.body.status ?? r.body.error.code).sort();
    expect(outcomes).toEqual(["daily_cap_exceeded", "executed"]);
    expect(h.services.refundPayment).toHaveBeenCalledTimes(1);
  });

  test("a token cannot be consumed twice even when replayed concurrently", async () => {
    const a = await depositOf(1000);
    const p = await call("refund_payment", { paymentId: a });
    const results = await Promise.all(
      [1, 2, 3].map(() =>
        call("refund_payment", { paymentId: a, confirmToken: p.body.confirmToken }),
      ),
    );
    expect(results.filter((r) => r.body.status === "executed")).toHaveLength(1);
    expect(h.services.refundPayment).toHaveBeenCalledTimes(1);
  });
});

describe("charge_no_show_fee", () => {
  async function noShowFor(
    clientId: string,
    startUtc: string,
    status: "no_show" | "late_cancelled" = "no_show",
  ) {
    const start = new Date(startUtc);
    const [row] = await h.t.db
      .insert(booking)
      .values({
        staffId: h.fx.staffId,
        locationId: h.fx.northside,
        clientId,
        status,
        during: { start, end: new Date(start.getTime() + 45 * 60_000) },
        totalCents: 9500,
        depositCents: 4750,
      })
      .returning({ id: booking.id });
    return row.id;
  }

  test("previews the exact amount and client, then charges the saved card", async () => {
    const id = await noShowFor(h.fx.clients.alex, "2026-11-10T01:00:00Z");
    const { preview, executed } = await twoStep("charge_no_show_fee", {
      bookingId: id,
      amountCents: 2500,
    });
    expect(preview.body.preview.summary).toContain('CHARGE $25.00 no show fee to "Alex Brown"');
    expect(preview.body.preview.summary).toContain("deposit is already kept");
    expect(h.services.chargeSavedCard).toHaveBeenCalledWith(h.t.db, {
      bookingId: id,
      kind: "no_show_fee",
      amountCents: 2500,
    });
    expect(executed.body.result).toEqual({
      bookingId: id,
      kind: "no_show_fee",
      chargedCents: 2500,
    });
    expect((await auditsFor("mcp.charge_no_show_fee", id))[0].data).toMatchObject({
      amountCents: 2500,
      kind: "no_show_fee",
    });
  });

  test("late-cancel fees need a late-cancelled booking and a saved card", async () => {
    const lateJo = h.fx.bookings.b3; // Jo has no saved card yet
    const noCard = await call("charge_no_show_fee", {
      bookingId: lateJo,
      amountCents: 1000,
      kind: "late_cancel_fee",
    });
    expect(noCard.body.error.message).toMatch(/no saved card/);
    await h.t.db
      .update(client)
      .set({ stripeCustomerId: "cus_jo" })
      .where(eq(client.id, h.fx.clients.jo));
    const { executed } = await twoStep("charge_no_show_fee", {
      bookingId: lateJo,
      amountCents: 1000,
      kind: "late_cancel_fee",
    });
    expect(executed.body.status).toBe("executed");
    expect(h.services.chargeSavedCard).toHaveBeenCalledWith(h.t.db, {
      bookingId: lateJo,
      kind: "late_cancel_fee",
      amountCents: 1000,
    });
  });

  test("refuses the wrong booking state, a second fee, unknown bookings and bad amounts", async () => {
    const wrongKind = await call("charge_no_show_fee", {
      bookingId: h.fx.bookings.b3,
      amountCents: 1000,
    });
    expect(wrongKind.body.error.code).toBe("precondition_failed");
    const completed = await call("charge_no_show_fee", {
      bookingId: h.fx.bookings.b1,
      amountCents: 1000,
    });
    expect(completed.body.error.code).toBe("precondition_failed");
    // b4 already had a $19 no-show fee charged in the fixture.
    const twice = await call("charge_no_show_fee", {
      bookingId: h.fx.bookings.b4,
      amountCents: 1000,
    });
    expect(twice.body.error.message).toMatch(/already been charged/);
    expect(
      (
        await call("charge_no_show_fee", {
          bookingId: "00000000-0000-4000-8000-000000000000",
          amountCents: 1000,
        })
      ).body.error.code,
    ).toBe("not_found");
    expect(
      (await call("charge_no_show_fee", { bookingId: h.fx.bookings.b4, amountCents: 0 })).body.error
        .code,
    ).toBe("invalid_input");
    expect(
      (
        await call("charge_no_show_fee", {
          bookingId: h.fx.bookings.b4,
          amountCents: 1000,
          kind: "tip",
        })
      ).body.error.code,
    ).toBe("invalid_input");
    expect(h.services.chargeSavedCard).not.toHaveBeenCalled();
  });

  test("fees obey the per-call cap too", async () => {
    const id = await noShowFor(h.fx.clients.alex, "2026-11-09T01:00:00Z");
    const r = await call("charge_no_show_fee", { bookingId: id, amountCents: 20001 });
    expect(r.body.error.code).toBe("amount_exceeds_per_call_cap");
  });
});
