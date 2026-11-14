import { describe, expect, test, vi } from "vitest";
import {
  buildXeroPort,
  escapeWhere,
  mapRefreshError,
  mapXeroError,
  tokensFrom,
  type AccountingApiLike,
} from "@/server/integrations/xero/adapter";
import {
  AuthRevokedError,
  ProviderValidationError,
  RateLimitedError,
  TransientProviderError,
} from "@/server/integrations/common/errors";

const mocked = (fn: unknown) => fn as ReturnType<typeof vi.fn>;

function fakeApi(over: Partial<AccountingApiLike> = {}) {
  const api = {
    getContacts: vi.fn(async () => ({ body: { contacts: [{ contactID: "c1" }] } })),
    createContacts: vi.fn(async () => ({ body: { contacts: [{ contactID: "c2" }] } })),
    createInvoices: vi.fn(async () => ({
      body: {
        invoices: [
          {
            invoiceID: "i1",
            invoiceNumber: "INV-1",
            status: "AUTHORISED",
            total: 150,
            amountDue: 150,
            amountPaid: 0,
          },
        ],
      },
    })),
    getInvoice: vi.fn(async () => ({
      body: {
        invoices: [
          {
            invoiceID: "i1",
            invoiceNumber: "INV-1",
            status: "PAID",
            total: 150.5,
            amountDue: 0,
            amountPaid: 150.5,
          },
        ],
      },
    })),
    getInvoiceAsPdf: vi.fn(async () => ({ body: Buffer.from("%PDF") })),
    createPayment: vi.fn(async () => ({ body: { payments: [{ paymentID: "p1" }] } })),
    createCreditNotes: vi.fn(async () => ({
      body: { creditNotes: [{ creditNoteID: "cn1", total: 75 }] },
    })),
    createCreditNoteAllocation: vi.fn(async () => ({ body: {} })),
    getAccounts: vi.fn(async () => ({
      body: {
        accounts: [
          { code: "200", name: "Sales", type: "REVENUE", status: "ACTIVE" },
          { code: "090", name: "Cash", type: "BANK", status: "ACTIVE" },
          {
            code: "610",
            name: "Stripe clearing",
            type: "CURRENT",
            status: "ACTIVE",
            enablePaymentsToAccount: true,
          },
          { name: "no code" },
        ],
      },
    })),
    ...over,
  };
  return api;
}

const port = (api: ReturnType<typeof fakeApi>) =>
  buildXeroPort("tenant", api as unknown as AccountingApiLike);

describe("xero port over xero-node", () => {
  test("finds a contact by email (quotes stripped from the where clause)", async () => {
    const api = fakeApi();
    expect(await port(api).findContactByEmail('a"b@x.com')).toEqual({ contactId: "c1" });
    expect(api.getContacts).toHaveBeenCalledWith("tenant", undefined, 'EmailAddress=="ab@x.com"');
    mocked(api.getContacts).mockResolvedValueOnce({ body: { contacts: [] } });
    expect(await port(api).findContactByEmail("none@x.com")).toBeNull();
    expect(escapeWhere('a\\"b')).toBe("ab");
  });

  test("creates a contact with email and mobile", async () => {
    const api = fakeApi();
    expect(
      await port(api).createContact({ name: "Sam", email: "s@x.com", phone: "+61400" }),
    ).toEqual({
      contactId: "c2",
    });
    expect(api.createContacts).toHaveBeenCalledWith(
      "tenant",
      {
        contacts: [
          {
            name: "Sam",
            emailAddress: "s@x.com",
            phones: [{ phoneType: "MOBILE", phoneNumber: "+61400" }],
          },
        ],
      },
      true,
    );
    await port(api).createContact({ name: "Only Name" });
    expect(api.createContacts).toHaveBeenLastCalledWith(
      "tenant",
      { contacts: [{ name: "Only Name" }] },
      true,
    );
  });

  test("creates an AUTHORISED ACCREC invoice in dollars with an idempotency key", async () => {
    const api = fakeApi();
    const summary = await port(api).createInvoice({
      contactId: "c1",
      reference: "booking-1",
      date: "2026-11-20",
      dueDate: "2026-11-20",
      lineAmountTypes: "NoTax",
      lines: [
        { description: "Haircut", quantity: 1, unitAmountCents: 9500, accountCode: "200" },
        {
          description: "GST line",
          quantity: 1,
          unitAmountCents: 5500,
          accountCode: "200",
          taxType: "OUTPUT",
        },
      ],
      idempotencyKey: "booking-invoice-1",
    });
    expect(summary).toEqual({
      invoiceId: "i1",
      invoiceNumber: "INV-1",
      status: "AUTHORISED",
      totalCents: 15000,
      amountDueCents: 15000,
      amountPaidCents: 0,
    });
    expect(api.createInvoices).toHaveBeenCalledWith(
      "tenant",
      {
        invoices: [
          {
            type: "ACCREC",
            contact: { contactID: "c1" },
            date: "2026-11-20",
            dueDate: "2026-11-20",
            reference: "booking-1",
            lineAmountTypes: "NoTax",
            status: "AUTHORISED",
            lineItems: [
              { description: "Haircut", quantity: 1, unitAmount: 95, accountCode: "200" },
              {
                description: "GST line",
                quantity: 1,
                unitAmount: 55,
                accountCode: "200",
                taxType: "OUTPUT",
              },
            ],
          },
        ],
      },
      true,
      2,
      "booking-invoice-1",
    );
  });

  test("getInvoice converts to cents without float drift; a missing invoice is an error", async () => {
    const api = fakeApi();
    expect(await port(api).getInvoice("i1")).toMatchObject({
      totalCents: 15050,
      amountPaidCents: 15050,
    });
    mocked(api.getInvoice).mockResolvedValueOnce({ body: { invoices: [] } });
    await expect(port(api).getInvoice("x")).rejects.toBeInstanceOf(TransientProviderError);
  });

  test("fetches the PDF with an Accept: application/pdf header", async () => {
    const api = fakeApi();
    const pdf = await port(api).getInvoicePdf("i1");
    expect(Buffer.from(pdf).toString()).toBe("%PDF");
    expect(api.getInvoiceAsPdf).toHaveBeenCalledWith("tenant", "i1", {
      headers: { Accept: "application/pdf" },
    });
  });

  test("creates payments against an invoice, and refunds against a credit note", async () => {
    const api = fakeApi();
    const input = {
      accountCode: "610",
      amountCents: 7500,
      date: "2026-11-14",
      reference: "pi_1",
      idempotencyKey: "k",
    };
    expect(await port(api).createPayment({ ...input, invoiceId: "i1" })).toEqual({
      paymentId: "p1",
    });
    expect(api.createPayment).toHaveBeenLastCalledWith(
      "tenant",
      {
        invoice: { invoiceID: "i1" },
        account: { code: "610" },
        date: "2026-11-14",
        amount: 75,
        reference: "pi_1",
      },
      "k",
    );
    expect(await port(api).refundCreditNote({ ...input, creditNoteId: "cn1" })).toEqual({
      paymentId: "p1",
    });
    expect(api.createPayment).toHaveBeenLastCalledWith(
      "tenant",
      {
        creditNote: { creditNoteID: "cn1" },
        account: { code: "610" },
        date: "2026-11-14",
        amount: 75,
        reference: "pi_1",
      },
      "k",
    );
  });

  test("a payment response with no id is treated as a failure", async () => {
    const api = fakeApi({ createPayment: vi.fn(async () => ({ body: { payments: [] } })) });
    const base = {
      accountCode: "1",
      amountCents: 1,
      date: "d",
      reference: "r",
      idempotencyKey: "k",
    };
    await expect(port(api).createPayment({ ...base, invoiceId: "i" })).rejects.toBeInstanceOf(
      TransientProviderError,
    );
    await expect(port(api).refundCreditNote({ ...base, creditNoteId: "c" })).rejects.toBeInstanceOf(
      TransientProviderError,
    );
  });

  test("creates ACCRECCREDIT credit notes and allocates them to an invoice", async () => {
    const api = fakeApi();
    expect(
      await port(api).createCreditNote({
        contactId: "c1",
        reference: "b1",
        date: "2026-11-14",
        lineAmountTypes: "Inclusive",
        lines: [
          {
            description: "Refund",
            quantity: 1,
            unitAmountCents: 7500,
            accountCode: "200",
            taxType: "OUTPUT",
          },
        ],
        idempotencyKey: "credit-1",
      }),
    ).toEqual({ creditNoteId: "cn1", totalCents: 7500 });
    expect(api.createCreditNotes).toHaveBeenCalledWith(
      "tenant",
      {
        creditNotes: [
          expect.objectContaining({
            type: "ACCRECCREDIT",
            status: "AUTHORISED",
            lineAmountTypes: "Inclusive",
          }),
        ],
      },
      true,
      2,
      "credit-1",
    );
    await port(api).allocateCreditNote({
      creditNoteId: "cn1",
      invoiceId: "i1",
      amountCents: 5000,
      date: "2026-11-14",
      idempotencyKey: "alloc",
    });
    expect(api.createCreditNoteAllocation).toHaveBeenCalledWith(
      "tenant",
      "cn1",
      { allocations: [{ invoice: { invoiceID: "i1" }, amount: 50, date: "2026-11-14" }] },
      true,
      "alloc",
    );
  });

  test("a credit note response with no id is a failure", async () => {
    const api = fakeApi({ createCreditNotes: vi.fn(async () => ({ body: { creditNotes: [] } })) });
    await expect(
      port(api).createCreditNote({
        contactId: "c",
        reference: "r",
        date: "d",
        lineAmountTypes: "NoTax",
        lines: [],
        idempotencyKey: "k",
      }),
    ).rejects.toBeInstanceOf(TransientProviderError);
  });

  test("a contact response with no id is a failure", async () => {
    const api = fakeApi({ createContacts: vi.fn(async () => ({ body: { contacts: [] } })) });
    await expect(port(api).createContact({ name: "x" })).rejects.toBeInstanceOf(
      TransientProviderError,
    );
  });

  test("lists accounts, flagging the ones that accept payments", async () => {
    expect(await port(fakeApi()).listAccounts()).toEqual([
      { code: "200", name: "Sales", type: "REVENUE", status: "ACTIVE", enablePayments: false },
      { code: "090", name: "Cash", type: "BANK", status: "ACTIVE", enablePayments: true },
      {
        code: "610",
        name: "Stripe clearing",
        type: "CURRENT",
        status: "ACTIVE",
        enablePayments: true,
      },
    ]);
    const empty = fakeApi({ getAccounts: vi.fn(async () => ({ body: {} })) });
    expect(await port(empty).listAccounts()).toEqual([]);
  });

  test("API failures are translated", async () => {
    const api = fakeApi({
      getInvoice: vi.fn(async () => {
        throw { response: { status: 429, headers: { "retry-after": "17" } } };
      }),
    });
    await expect(port(api).getInvoice("i")).rejects.toMatchObject({ retryAfterSec: 17 });
  });
});

describe("mapXeroError", () => {
  test.each([
    [{ response: { status: 401 } }, AuthRevokedError],
    [{ response: { status: 403 } }, AuthRevokedError],
    [{ response: { status: 400 } }, ProviderValidationError],
    [{ response: { status: 404 } }, ProviderValidationError],
    [{ response: { status: 500 } }, TransientProviderError],
    [{ message: "ECONNRESET" }, TransientProviderError],
    ["string", TransientProviderError],
  ])("%j", (input, expected) => {
    expect(mapXeroError(input)).toBeInstanceOf(expected);
  });

  test("429 uses Retry-After, defaulting to 60s", () => {
    expect(
      (
        mapXeroError({
          response: { status: 429, headers: { "retry-after": "5" } },
        }) as RateLimitedError
      ).retryAfterSec,
    ).toBe(5);
    expect((mapXeroError({ response: { status: 429 } }) as RateLimitedError).retryAfterSec).toBe(
      60,
    );
  });

  test("surfaces Xero's validation messages", () => {
    const nested = mapXeroError({
      response: {
        status: 400,
        data: {
          Elements: [
            {
              ValidationErrors: [{ Message: "Account code is not valid" }, { Message: "Another" }],
            },
          ],
        },
      },
    });
    expect(nested.message).toBe("Account code is not valid; Another");
    expect(mapXeroError({ response: { status: 400 }, body: { Message: "Bad" } }).message).toBe(
      "Bad",
    );
  });
});

describe("tokens and refresh errors", () => {
  test("tokensFrom reads expires_at (seconds), else expires_in, else 30 minutes", () => {
    expect(tokensFrom({ access_token: "a", refresh_token: "r", expires_at: 2000 })).toMatchObject({
      accessToken: "a",
      refreshToken: "r",
      expiresAt: 2_000_000,
    });
    expect(
      tokensFrom({ access_token: "a", refresh_token: "r", expires_in: 60 }, 1000).expiresAt,
    ).toBe(61_000);
    expect(tokensFrom({ access_token: "a", refresh_token: "r" }, 1000).expiresAt).toBe(
      1000 + 1_800_000,
    );
    expect(() => tokensFrom({ access_token: "a" })).toThrow(AuthRevokedError);
  });

  test("invalid_grant and a 400 from the token endpoint mean reconnect; 5xx does not", () => {
    expect(
      mapRefreshError({ response: { status: 400, data: { error: "invalid_grant" } } }),
    ).toBeInstanceOf(AuthRevokedError);
    expect(mapRefreshError({ response: { status: 400, data: {} } })).toBeInstanceOf(
      AuthRevokedError,
    );
    expect(
      mapRefreshError({ response: { status: 401, data: { error: "invalid_client" } } }),
    ).toBeInstanceOf(AuthRevokedError);
    expect(mapRefreshError({ response: { status: 503 } })).toBeInstanceOf(TransientProviderError);
    expect(mapRefreshError({ response: { status: 429 } })).toBeInstanceOf(RateLimitedError);
  });
});
