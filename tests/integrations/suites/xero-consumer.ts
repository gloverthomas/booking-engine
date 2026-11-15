import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, test } from "vitest";
import { booking, client, integrationAccount, payment, webhookEvent } from "@/db/schema";
import {
  AuthRevokedError,
  ProviderValidationError,
  RateLimitedError,
  TransientProviderError,
} from "@/server/integrations/common/errors";
import { handleXeroDomainEvent, retryInvoiceEmail } from "@/server/integrations/xero/consumer";
import { createTestDb } from "../../helpers/test-db";
import { setupTestDb } from "../helpers";
import { seedBooking, seedPayment, type BookingSeed } from "../helpers";
import { fakeXero, seedXero, xeroDeps, type FakeXero, type XeroTestDeps } from "../xero-helpers";

const shared = setupTestDb();

type TestDb = Awaited<ReturnType<typeof createTestDb>>;

describe("consumer.xero", () => {
  let t: TestDb;
  let seed: BookingSeed;
  let xero: FakeXero;
  let deps: XeroTestDeps;

  beforeEach(async () => {
    t = shared.current;
    seed = await seedBooking(t.db);
    await seedXero(t.db, seed.businessId);
    xero = fakeXero();
    deps = xeroDeps(t.db, xero);
  });
  const confirm = () =>
    handleXeroDomainEvent(deps, { type: "booking.confirmed", bookingId: seed.bookingId });
  const getBooking = async () =>
    (await t.db.select().from(booking).where(eq(booking.id, seed.bookingId)))[0];
  const getClient = async () =>
    (await t.db.select().from(client).where(eq(client.id, seed.clientId)))[0];
  const account = async () => (await t.db.select().from(integrationAccount))[0];
  const paymentRow = async (id: string) =>
    (await t.db.select().from(payment).where(eq(payment.id, id)))[0];
  const setSyncState = (patch: Record<string, unknown>) =>
    t.db.update(integrationAccount).set({
      syncState: {
        clearingAccountCode: "610",
        cashAccountCode: "090",
        eftposAccountCode: "091",
        ...patch,
      },
    });

  describe("booking.confirmed", () => {
    test("creates the contact and an AUTHORISED invoice (one line per service, no GST), applies the deposit to the clearing account and emails the PDF", async () => {
      const deposit = await seedPayment(t.db, seed.bookingId);

      await confirm();

      const contactCall = xero.calls.find((c) => c.method === "createContact")!.input;
      expect(contactCall).toEqual({
        name: "Sam Client",
        email: "sam@example.com",
        phone: undefined,
      });
      expect((await getClient()).xeroContactId).toBe("contact-1");

      const [invoice] = [...xero.invoices.values()];
      expect(invoice.input).toMatchObject({
        contactId: "contact-1",
        reference: seed.bookingId,
        date: "2026-11-20", // 10:00 Melbourne
        dueDate: "2026-11-20",
        lineAmountTypes: "NoTax",
        lines: [
          { description: "Haircut", quantity: 1, unitAmountCents: 9500, accountCode: "200" },
          { description: "Beard trim", quantity: 1, unitAmountCents: 5500, accountCode: "200" },
        ],
      });
      expect(invoice.input.lines.every((l) => l.taxType === undefined)).toBe(true);
      expect((await getBooking()).xeroInvoiceId).toBe(invoice.invoiceId);

      const paymentCall = xero.calls.find((c) => c.method === "createPayment")!.input;
      expect(paymentCall).toMatchObject({
        invoiceId: invoice.invoiceId,
        accountCode: "610",
        amountCents: 7500,
        date: "2026-11-14",
      });
      expect((await paymentRow(deposit.id)).xeroPaymentId).toBe("pay-3");
      expect(invoice.amountDueCents).toBe(7500);

      expect(deps.sendInvoiceEmail).toHaveBeenCalledTimes(1);
      expect(deps.sendInvoiceEmail).toHaveBeenCalledWith(t.db, {
        bookingId: seed.bookingId,
        invoiceNumber: invoice.invoiceNumber,
        pdf: xero.pdf,
      });
      expect((await account()).lastError).toBeNull();
      expect((await account()).lastSyncAt).not.toBeNull();
    });

    test("is idempotent: a redelivered event makes no further calls and sends no second email", async () => {
      await seedPayment(t.db, seed.bookingId);
      await confirm();
      const before = xero.calls.length;
      await confirm();
      expect(xero.calls.length).toBe(before);
      expect(deps.sendInvoiceEmail).toHaveBeenCalledTimes(1);
    });

    test("matches an existing Xero contact by email instead of creating one", async () => {
      xero.contacts.set("sam@example.com", "existing-contact");
      await confirm();
      expect(xero.count("createContact")).toBe(0);
      expect((await getClient()).xeroContactId).toBe("existing-contact");
    });

    test("reuses the stored contact id with no contact lookups", async () => {
      await t.db.update(client).set({ xeroContactId: "stored" });
      await confirm();
      expect(xero.count("findContactByEmail")).toBe(0);
      expect(xero.count("createContact")).toBe(0);
      expect([...xero.invoices.values()][0].input.contactId).toBe("stored");
    });

    test("a client with no email gets a contact by name only", async () => {
      await t.db.update(client).set({ email: null, phone: "+61410123456" });
      await confirm();
      expect(xero.count("findContactByEmail")).toBe(0);
      expect(xero.calls.find((c) => c.method === "createContact")!.input).toEqual({
        name: "Sam Client",
        email: undefined,
        phone: "+61410123456",
      });
    });

    test("GST-registered mode books tax-inclusive lines with the OUTPUT tax type", async () => {
      await setSyncState({ taxType: "OUTPUT" });
      await confirm();
      const [invoice] = [...xero.invoices.values()];
      expect(invoice.input.lineAmountTypes).toBe("Inclusive");
      expect(invoice.input.lines.every((l) => l.taxType === "OUTPUT")).toBe(true);
    });

    test("an adjustment line reconciles services to the booking total", async () => {
      await t.db.update(booking).set({ totalCents: 14000 });
      await confirm();
      const [invoice] = [...xero.invoices.values()];
      expect(invoice.input.lines.at(-1)).toMatchObject({
        description: "Adjustment",
        unitAmountCents: -1000,
      });
      expect(invoice.totalCents).toBe(14000);
    });

    test("a booking with no service rows is invoiced as one appointment line", async () => {
      await t.db.update(booking).set({ totalCents: 8000 });
      const { bookingService } = await import("@/db/schema");
      await t.db.delete(bookingService);
      await confirm();
      expect([...xero.invoices.values()][0].input.lines).toMatchObject([
        { description: "Appointment", unitAmountCents: 8000 },
      ]);
    });

    test("skips bookings that are not live, free, or missing", async () => {
      await t.db.update(booking).set({ status: "pending_payment" });
      await confirm();
      await t.db.update(booking).set({ status: "confirmed", totalCents: 0 });
      await confirm();
      await handleXeroDomainEvent(deps, {
        type: "booking.confirmed",
        bookingId: "00000000-0000-4000-8000-000000000000",
      });
      await handleXeroDomainEvent(deps, { type: "booking.confirmed" });
      expect(xero.calls).toHaveLength(0);
    });

    test("emailInvoice off: invoice created, nothing sent", async () => {
      await setSyncState({ emailInvoice: false });
      await confirm();
      expect(xero.count("createInvoice")).toBe(1);
      expect(deps.sendInvoiceEmail).not.toHaveBeenCalled();
    });

    test("a failing email send never fails the push; the reconcile retry sends it later", async () => {
      deps.sendInvoiceEmail.mockRejectedValueOnce(new Error("sendInvoiceEmail not implemented"));
      await expect(confirm()).resolves.toBeUndefined();
      expect((await account()).lastError).toMatch(/Invoice email failed/);
      const [claim] = await t.db.select().from(webhookEvent);
      expect(claim.processedAt).toBeNull();

      await retryInvoiceEmail(deps, seed.bookingId);
      expect(deps.sendInvoiceEmail).toHaveBeenCalledTimes(2);
      expect((await t.db.select().from(webhookEvent))[0].processedAt).not.toBeNull();
      // Nothing more to send once it went through.
      await retryInvoiceEmail(deps, seed.bookingId);
      expect(deps.sendInvoiceEmail).toHaveBeenCalledTimes(2);
    });

    test("retryInvoiceEmail ignores bookings without an invoice and a disconnected account", async () => {
      await retryInvoiceEmail(deps, seed.bookingId);
      expect(deps.sendInvoiceEmail).not.toHaveBeenCalled();
      await t.db.update(integrationAccount).set({ status: "disconnected" });
      await retryInvoiceEmail(deps, seed.bookingId);
      expect(xero.calls).toHaveLength(0);
    });

    test("retryInvoiceEmail records a Xero failure", async () => {
      await confirm();
      await t.db.update(webhookEvent).set({ processedAt: null });
      xero.failures.getInvoicePdf = [new TransientProviderError("xero 503")];
      await retryInvoiceEmail(deps, seed.bookingId);
      expect((await account()).lastError).toBe("xero 503");
    });
  });

  describe("payment.succeeded", () => {
    test("manual payments go to the cash / EFTPOS accounts, other and Stripe to the clearing account", async () => {
      await confirm();
      const cash = await seedPayment(t.db, seed.bookingId, {
        kind: "balance",
        method: "cash",
        amountCents: 3000,
        stripePaymentIntentId: null,
      });
      const eftpos = await seedPayment(t.db, seed.bookingId, {
        kind: "balance",
        method: "eftpos",
        amountCents: 2000,
        stripePaymentIntentId: null,
      });
      const other = await seedPayment(t.db, seed.bookingId, {
        kind: "balance",
        method: "other",
        amountCents: 1000,
        stripePaymentIntentId: null,
      });
      for (const p of [cash, eftpos, other]) {
        await handleXeroDomainEvent(deps, { type: "payment.succeeded", paymentId: p.id });
      }
      const accounts = xero.calls
        .filter((c) => c.method === "createPayment")
        .map((c) => (c.input as { accountCode: string }).accountCode);
      expect(accounts).toEqual(["090", "091", "610"]);
      for (const p of [cash, eftpos, other]) {
        expect((await paymentRow(p.id)).xeroPaymentId).toBeTruthy();
      }
    });

    test("is idempotent per payment", async () => {
      await confirm();
      const p = await seedPayment(t.db, seed.bookingId, { kind: "balance", method: "cash" });
      await handleXeroDomainEvent(deps, { type: "payment.succeeded", paymentId: p.id });
      await handleXeroDomainEvent(deps, { type: "payment.succeeded", paymentId: p.id });
      expect(xero.count("createPayment")).toBe(1);
    });

    test("arriving before booking.confirmed it waits; confirmed then applies it", async () => {
      await t.db.update(booking).set({ status: "pending_payment" });
      const p = await seedPayment(t.db, seed.bookingId);
      await handleXeroDomainEvent(deps, { type: "payment.succeeded", paymentId: p.id });
      expect(xero.calls).toHaveLength(0);

      await t.db.update(booking).set({ status: "confirmed" });
      await confirm();
      expect(xero.count("createPayment")).toBe(1);
    });

    test("for a confirmed booking with no invoice yet, creates the invoice and applies the payment", async () => {
      const p = await seedPayment(t.db, seed.bookingId);
      await handleXeroDomainEvent(deps, { type: "payment.succeeded", paymentId: p.id });
      expect(xero.count("createInvoice")).toBe(1);
      expect(xero.count("createPayment")).toBe(1);
    });

    test("ignores pending payments, payments without a booking, refund rows and unknown ids", async () => {
      await confirm();
      const pending = await seedPayment(t.db, seed.bookingId, { status: "pending" });
      const orphan = await seedPayment(t.db, seed.bookingId, { bookingId: null });
      const refund = await seedPayment(t.db, seed.bookingId, { kind: "refund" });
      for (const id of [pending.id, orphan.id, refund.id, "00000000-0000-4000-8000-000000000000"]) {
        await handleXeroDomainEvent(deps, { type: "payment.succeeded", paymentId: id });
      }
      await handleXeroDomainEvent(deps, { type: "payment.succeeded" });
      expect(xero.count("createPayment")).toBe(0);
    });

    test("a no-show fee is its own invoice, then paid; a retry does not duplicate the invoice", async () => {
      await confirm();
      const fee = await seedPayment(t.db, seed.bookingId, {
        kind: "no_show_fee",
        amountCents: 2500,
      });
      xero.failures.createPayment = [new TransientProviderError("blip")];
      await expect(
        handleXeroDomainEvent(deps, { type: "payment.succeeded", paymentId: fee.id }),
      ).rejects.toThrow("blip");
      await handleXeroDomainEvent(deps, { type: "payment.succeeded", paymentId: fee.id });

      const feeInvoices = [...xero.invoices.values()].filter(
        (i) => i.input.lines[0].description === "No-show fee",
      );
      expect(feeInvoices).toHaveLength(1);
      expect(feeInvoices[0]).toMatchObject({ totalCents: 2500, amountDueCents: 0, status: "PAID" });
      expect((await paymentRow(fee.id)).xeroPaymentId).toBeTruthy();
    });

    test("a late-cancellation fee is labelled accordingly", async () => {
      await confirm();
      const fee = await seedPayment(t.db, seed.bookingId, {
        kind: "late_cancel_fee",
        amountCents: 1000,
      });
      await handleXeroDomainEvent(deps, { type: "payment.succeeded", paymentId: fee.id });
      const labels = [...xero.invoices.values()].map((i) => i.input.lines[0].description);
      expect(labels).toContain("Late cancellation fee");
    });
  });

  describe("payment.refunded", () => {
    async function refundRow(original: { id: string }, amountCents = 7500) {
      return seedPayment(t.db, seed.bookingId, {
        kind: "refund",
        method: "stripe_online",
        status: "succeeded",
        amountCents,
        stripePaymentIntentId: null,
        stripeRefundId: "re_123",
        metadata: { refundOf: original.id },
      });
    }

    test("raises a credit note for the refunded amount and pays it back out of the original's account", async () => {
      const deposit = await seedPayment(t.db, seed.bookingId);
      await confirm();
      const refund = await refundRow(deposit);

      await handleXeroDomainEvent(deps, { type: "payment.refunded", paymentId: refund.id });

      const [cn] = [...xero.creditNotes.values()];
      expect(cn).toMatchObject({
        reference: seed.bookingId,
        totalCents: 7500,
        lineAmountTypes: "NoTax",
      });
      const out = xero.calls.find((c) => c.method === "refundCreditNote")!.input;
      expect(out).toMatchObject({ accountCode: "610", amountCents: 7500, reference: "re_123" });
      const row = await paymentRow(refund.id);
      expect(row.xeroPaymentId).toBeTruthy();
      expect((row.metadata.xero as { creditNoteId: string }).creditNoteId).toBeTruthy();
    });

    test("a retry after the refund payment failed reuses the stored credit note", async () => {
      const deposit = await seedPayment(t.db, seed.bookingId);
      await confirm();
      const refund = await refundRow(deposit);
      xero.failures.refundCreditNote = [new TransientProviderError("blip")];
      await expect(
        handleXeroDomainEvent(deps, { type: "payment.refunded", paymentId: refund.id }),
      ).rejects.toThrow("blip");
      await handleXeroDomainEvent(deps, { type: "payment.refunded", paymentId: refund.id });
      expect(xero.count("createCreditNote")).toBe(1);
      expect(xero.count("refundCreditNote")).toBe(2);
      // And once done, redelivery is a no-op.
      await handleXeroDomainEvent(deps, { type: "payment.refunded", paymentId: refund.id });
      expect(xero.count("refundCreditNote")).toBe(2);
    });

    test("a cash refund goes out of the cash account", async () => {
      await confirm();
      const cash = await seedPayment(t.db, seed.bookingId, {
        kind: "balance",
        method: "cash",
        amountCents: 3000,
      });
      await handleXeroDomainEvent(deps, { type: "payment.succeeded", paymentId: cash.id });
      const refund = await seedPayment(t.db, seed.bookingId, {
        kind: "refund",
        method: "cash",
        amountCents: 3000,
        metadata: { refundOf: cash.id },
      });
      await handleXeroDomainEvent(deps, { type: "payment.refunded", paymentId: refund.id });
      expect(xero.calls.find((c) => c.method === "refundCreditNote")!.input).toMatchObject({
        accountCode: "090",
      });
    });

    test("if the original payment never reached Xero it is pushed first", async () => {
      await confirm();
      const late = await seedPayment(t.db, seed.bookingId, {
        kind: "balance",
        method: "cash",
        amountCents: 3000,
      });
      const refund = await seedPayment(t.db, seed.bookingId, {
        kind: "refund",
        method: "cash",
        amountCents: 3000,
        metadata: { refundOf: late.id },
      });
      await handleXeroDomainEvent(deps, { type: "payment.refunded", paymentId: refund.id });
      const order = xero.calls
        .map((c) => c.method)
        .filter((m) => m === "createPayment" || m === "refundCreditNote");
      expect(order.slice(-2)).toEqual(["createPayment", "refundCreditNote"]);
      expect((await paymentRow(late.id)).xeroPaymentId).toBeTruthy();
    });

    test("skips non-refund rows, bookings without an invoice, and unknown ids", async () => {
      const deposit = await seedPayment(t.db, seed.bookingId);
      await handleXeroDomainEvent(deps, { type: "payment.refunded", paymentId: deposit.id });
      const refund = await refundRow(deposit);
      await handleXeroDomainEvent(deps, { type: "payment.refunded", paymentId: refund.id });
      await handleXeroDomainEvent(deps, {
        type: "payment.refunded",
        paymentId: "00000000-0000-4000-8000-000000000000",
      });
      await handleXeroDomainEvent(deps, { type: "payment.refunded" });
      expect(xero.count("createCreditNote")).toBe(0);
    });

    test("a refund row without refundOf falls back to its own method", async () => {
      await confirm();
      const refund = await seedPayment(t.db, seed.bookingId, { kind: "refund", amountCents: 500 });
      await handleXeroDomainEvent(deps, { type: "payment.refunded", paymentId: refund.id });
      expect(xero.count("refundCreditNote")).toBe(1);
    });
  });

  describe("booking.cancelled / booking.no_show", () => {
    test("a forfeited deposit stays as revenue: the unpaid balance is credited and allocated", async () => {
      await seedPayment(t.db, seed.bookingId);
      await confirm();
      const [invoice] = [...xero.invoices.values()];
      expect(invoice.amountDueCents).toBe(7500);

      await handleXeroDomainEvent(deps, { type: "booking.cancelled", bookingId: seed.bookingId });

      expect(xero.calls.find((c) => c.method === "allocateCreditNote")!.input).toMatchObject({
        invoiceId: invoice.invoiceId,
        amountCents: 7500,
      });
      expect(invoice).toMatchObject({ amountDueCents: 0, status: "PAID" });
      // Redelivery: the invoice is settled, nothing more happens.
      await handleXeroDomainEvent(deps, { type: "booking.no_show", bookingId: seed.bookingId });
      expect(xero.count("createCreditNote")).toBe(1);
    });

    test("is skipped when write-off is off, when no invoice exists, and when nothing is owed", async () => {
      await handleXeroDomainEvent(deps, { type: "booking.cancelled", bookingId: seed.bookingId });
      expect(xero.calls).toHaveLength(0);

      await confirm();
      await setSyncState({ writeOffOnCancel: false });
      await handleXeroDomainEvent(deps, { type: "booking.cancelled", bookingId: seed.bookingId });
      expect(xero.count("createCreditNote")).toBe(0);

      await setSyncState({});
      const [invoice] = [...xero.invoices.values()];
      invoice.amountDueCents = 0;
      await handleXeroDomainEvent(deps, { type: "booking.cancelled", bookingId: seed.bookingId });
      expect(xero.count("createCreditNote")).toBe(0);
      await handleXeroDomainEvent(deps, { type: "booking.cancelled" });
    });
  });

  describe("booking.completed", () => {
    test("whatever is still owed at checkout (the cash discount) is credited and allocated, once", async () => {
      await seedPayment(t.db, seed.bookingId);
      await confirm();
      const [invoice] = [...xero.invoices.values()];
      expect(invoice.amountDueCents).toBe(7500);

      await handleXeroDomainEvent(deps, { type: "booking.completed", bookingId: seed.bookingId });

      expect(xero.calls.find((c) => c.method === "createCreditNote")!.input).toMatchObject({
        lines: [expect.objectContaining({ description: "Discount at checkout" })],
      });
      expect(invoice).toMatchObject({ amountDueCents: 0, status: "PAID" });
      await handleXeroDomainEvent(deps, { type: "booking.completed", bookingId: seed.bookingId });
      expect(xero.count("createCreditNote")).toBe(1);
    });

    test("does nothing without an invoice, and ignores the write-off-on-cancel setting", async () => {
      await handleXeroDomainEvent(deps, { type: "booking.completed", bookingId: seed.bookingId });
      expect(xero.calls).toHaveLength(0);

      await confirm();
      await setSyncState({ writeOffOnCancel: false });
      await handleXeroDomainEvent(deps, { type: "booking.completed", bookingId: seed.bookingId });
      expect(xero.count("createCreditNote")).toBe(1);
      await handleXeroDomainEvent(deps, { type: "booking.completed" });
    });
  });

  describe("failure handling", () => {
    test("a missing clearing account: the invoice still goes out, lastError says what to fix, no retry storm", async () => {
      await setSyncState({ clearingAccountCode: undefined });
      await seedPayment(t.db, seed.bookingId);

      await expect(confirm()).resolves.toBeUndefined();

      expect(xero.count("createInvoice")).toBe(1);
      expect(xero.count("createPayment")).toBe(0);
      expect(deps.sendInvoiceEmail).toHaveBeenCalledTimes(1);
      const acc = await account();
      expect(acc.lastError).toMatch(/clearingAccountCode/);
      expect(acc.status).toBe("connected");
    });

    test("a transient failure is recorded and rethrown so the queue retries with backoff; the retry succeeds and clears it", async () => {
      xero.failures.createInvoice = [new TransientProviderError("xero 503")];
      await expect(confirm()).rejects.toThrow("xero 503");
      expect((await account()).lastError).toBe("xero 503");
      expect((await getBooking()).xeroInvoiceId).toBeNull();

      await confirm();
      expect((await account()).lastError).toBeNull();
      expect((await getBooking()).xeroInvoiceId).toBeTruthy();
    });

    test("a 429 with a short Retry-After is waited out in-process and the call retried", async () => {
      const sleeps: number[] = [];
      deps = xeroDeps(t.db, xero, { backoff: { sleep: async (ms) => void sleeps.push(ms) } });
      xero.failures.createInvoice = [new RateLimitedError("slow down", 7)];
      await confirm();
      expect(sleeps).toEqual([7000]);
      expect(xero.count("createInvoice")).toBe(2);
      expect((await getBooking()).xeroInvoiceId).toBeTruthy();
    });

    test("a long Retry-After (daily limit) is not slept on: it fails the job so the queue retries later", async () => {
      xero.failures.createInvoice = [new RateLimitedError("daily limit", 3600)];
      await expect(confirm()).rejects.toBeInstanceOf(RateLimitedError);
      expect((await account()).lastError).toBe("daily limit");
    });

    test("revoked access flips the account to 'error' for the reconnect prompt and drops the event", async () => {
      xero.failures.findContactByEmail = [new AuthRevokedError("forbidden")];
      await expect(confirm()).resolves.toBeUndefined();
      const acc = await account();
      expect(acc.status).toBe("error");
      expect(acc.lastError).toMatch(/Reconnect Xero/);
    });

    test("data Xero rejects is recorded, not retried", async () => {
      xero.failures.createInvoice = [
        new ProviderValidationError("Account code '200' is not a valid code"),
      ];
      await expect(confirm()).resolves.toBeUndefined();
      expect((await account()).lastError).toMatch(/not a valid code/);
      expect(xero.count("createInvoice")).toBe(1);
    });

    test("not connected: skipped quietly", async () => {
      await t.db.update(integrationAccount).set({ status: "disconnected" });
      await confirm();
      expect(xero.calls).toHaveLength(0);
      expect((await account()).lastError).toBeNull();
    });

    test("ignores event types it does not handle", async () => {
      await handleXeroDomainEvent(deps, { type: "booking.rescheduled", bookingId: seed.bookingId });
      await handleXeroDomainEvent(deps, { type: "client.updated" });
      expect(xero.calls).toHaveLength(0);
    });
  });

  describe("bookings imported from another system", () => {
    beforeEach(async () => {
      // Their invoices already exist in the old system, so Xero must hear nothing about them.
      await t.db
        .update(booking)
        .set({ source: "import:timely" })
        .where(eq(booking.id, seed.bookingId));
    });

    test("confirming, paying, refunding and cancelling create no invoices, payments or credit notes", async () => {
      const deposit = await seedPayment(t.db, seed.bookingId);
      await confirm();
      await handleXeroDomainEvent(deps, { type: "payment.succeeded", paymentId: deposit.id });
      await handleXeroDomainEvent(deps, { type: "payment.refunded", paymentId: deposit.id });
      await handleXeroDomainEvent(deps, { type: "booking.cancelled", bookingId: seed.bookingId });
      await handleXeroDomainEvent(deps, { type: "booking.completed", bookingId: seed.bookingId });
      expect(xero.calls).toHaveLength(0);
      expect((await getBooking()).xeroInvoiceId).toBeNull();
    });

    test("a booking made in this system still syncs", async () => {
      await t.db.update(booking).set({ source: "online" }).where(eq(booking.id, seed.bookingId));
      await confirm();
      expect(xero.count("createInvoice")).toBe(1);
    });
  });
});
