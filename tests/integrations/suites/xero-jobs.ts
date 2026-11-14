import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, test, vi } from "vitest";
import type { PgBoss } from "pg-boss";
import { booking, integrationAccount, payment } from "@/db/schema";
import { runXeroReconcile, XERO_JOBS } from "@/server/integrations/xero/jobs";
import { register } from "@/worker/handlers/xero";
import { createTestDb } from "../../helpers/test-db";
import { setupTestDb } from "../helpers";
import { fixedNow, NOW, seedBooking, seedPayment, silentLog, type BookingSeed } from "../helpers";
import { fakeXero, seedXero, xeroDeps, type FakeXero, type XeroTestDeps } from "../xero-helpers";

const shared = setupTestDb();

type TestDb = Awaited<ReturnType<typeof createTestDb>>;

describe("xero reconcile", () => {
  let t: TestDb;
  let seed: BookingSeed;
  let xero: FakeXero;
  let deps: XeroTestDeps;

  beforeEach(async () => {
    t = shared.current;
    seed = await seedBooking(t.db, { createdAt: new Date(NOW.getTime() - 86_400_000) });
    await seedXero(t.db, seed.businessId);
    xero = fakeXero();
    deps = xeroDeps(t.db, xero);
  });
  test("invoices a recent confirmed booking whose event was lost, and does not repeat itself", async () => {
    await seedPayment(t.db, seed.bookingId);
    expect(await runXeroReconcile(deps)).toBeGreaterThanOrEqual(1);
    expect(xero.count("createInvoice")).toBe(1);
    expect(xero.count("createPayment")).toBe(1);
    expect((await t.db.select().from(booking))[0].xeroInvoiceId).toBeTruthy();

    const calls = xero.calls.length;
    await runXeroReconcile(deps);
    expect(xero.calls.length).toBe(calls);
  });

  test("picks up payments that were blocked on configuration once it is fixed", async () => {
    await t.db.update(integrationAccount).set({ syncState: {} });
    await seedPayment(t.db, seed.bookingId);
    await runXeroReconcile(deps); // invoice made, payment blocked: no clearing account
    expect(xero.count("createPayment")).toBe(0);

    await t.db.update(integrationAccount).set({ syncState: { clearingAccountCode: "610" } });
    await runXeroReconcile(deps);
    expect(xero.count("createPayment")).toBe(1);
  });

  test("books refunds and fees that are missing, and retries pending invoice emails", async () => {
    const deposit = await seedPayment(t.db, seed.bookingId);
    await runXeroReconcile(deps);
    await seedPayment(t.db, seed.bookingId, {
      kind: "refund",
      amountCents: 1000,
      stripePaymentIntentId: null,
      metadata: { refundOf: deposit.id },
    });
    await seedPayment(t.db, seed.bookingId, { kind: "no_show_fee", amountCents: 2000 });
    await runXeroReconcile(deps);
    expect(xero.count("refundCreditNote")).toBe(1);
    expect(xero.count("createInvoice")).toBe(2); // booking + fee
  });

  test("retries an unsent invoice email in the same run, and not again once sent", async () => {
    deps.sendInvoiceEmail.mockRejectedValueOnce(new Error("smtp down"));
    await runXeroReconcile(deps); // invoice created, email fails, then the pending-email pass retries it
    expect(deps.sendInvoiceEmail).toHaveBeenCalledTimes(2);
    await runXeroReconcile(deps);
    expect(deps.sendInvoiceEmail).toHaveBeenCalledTimes(2);
  });

  test("ignores old bookings, zero-total bookings and an account that is not connected", async () => {
    await t.db
      .update(booking)
      .set({ createdAt: new Date(NOW.getTime() - 30 * 86_400_000) })
      .where(eq(booking.id, seed.bookingId));
    expect(await runXeroReconcile(deps)).toBe(0);
    await t.db.update(booking).set({ createdAt: NOW, totalCents: 0 });
    expect(await runXeroReconcile(deps)).toBe(0);
    await t.db.update(booking).set({ totalCents: 15000 });
    await t.db.update(integrationAccount).set({ status: "error" });
    expect(await runXeroReconcile(deps)).toBe(0);
    expect(xero.calls).toHaveLength(0);
  });

  test("a failing item does not stop the run", async () => {
    xero.failures.createContact = [new Error("xero down")];
    await expect(runXeroReconcile(deps)).resolves.toBeGreaterThanOrEqual(1);
  });

  test("never touches payments that are already in Xero", async () => {
    await seedPayment(t.db, seed.bookingId, { xeroPaymentId: "already" });
    await t.db.update(booking).set({ xeroInvoiceId: "inv-x" });
    expect(await runXeroReconcile(deps)).toBe(0);
    expect((await t.db.select().from(payment))[0].xeroPaymentId).toBe("already");
  });
});

describe("xero worker registration", () => {
  test("registers the consumer with retry/backoff, keepalive and reconcile; handlers run end to end when not connected", async () => {
    const handlers = new Map<string, (jobs: Array<{ data: unknown }>) => Promise<void>>();
    const boss = {
      createQueue: vi.fn(async () => {}),
      updateQueue: vi.fn(async () => {}),
      schedule: vi.fn(async (_name: string, _cron: string) => {}),
      work: vi.fn(async (name: string, ...rest: unknown[]) => {
        handlers.set(name, rest.at(-1) as never);
        return "id";
      }),
    };
    const t = shared.current;
    const seed = await seedBooking(t.db);
    vi.stubEnv("DATABASE_URL", "postgres://ci:ci@localhost:5432/ci");

    await register({ boss: boss as unknown as PgBoss, db: t.db, log: silentLog, now: fixedNow });

    expect(boss.updateQueue).toHaveBeenCalledWith(
      XERO_JOBS.consumer,
      expect.objectContaining({ retryBackoff: true, retryDelayMax: 3600 }),
    );
    expect(boss.schedule.mock.calls.map((c) => c[0])).toEqual([
      XERO_JOBS.keepalive,
      XERO_JOBS.reconcile,
    ]);

    await handlers.get(XERO_JOBS.consumer)!([
      { data: { type: "booking.confirmed", bookingId: seed.bookingId } },
    ]);
    await handlers.get(XERO_JOBS.keepalive)!([]);
    await handlers.get(XERO_JOBS.reconcile)!([]);
    vi.unstubAllEnvs();
  });
});
