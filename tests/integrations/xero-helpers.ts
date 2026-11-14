import { vi } from "vitest";
import type { Db } from "@/server/db-types";
import type {
  XeroAccount,
  XeroAuthPort,
  XeroCreditNoteInput,
  XeroInvoiceInput,
  XeroInvoiceSummary,
  XeroPort,
  XeroTokens,
} from "@/server/integrations/xero/port";
import type { XeroConsumerDeps } from "@/server/integrations/xero/consumer";
import { fixedNow, NOW, seedAccount, silentLog, testEnv } from "./helpers";

type Method = keyof XeroPort;

export interface FakeXero extends XeroPort {
  calls: Array<{ method: Method; input: unknown }>;
  contacts: Map<string, string>;
  invoices: Map<string, XeroInvoiceSummary & { input: XeroInvoiceInput }>;
  creditNotes: Map<string, XeroCreditNoteInput & { totalCents: number }>;
  /** Errors thrown by the next calls to a method, in order. */
  failures: Partial<Record<Method, Error[]>>;
  accounts: XeroAccount[];
  pdf: Uint8Array;
  count(method: Method): number;
}

/** Stateful in-memory Xero: invoices track what is paid / credited so tests can check the books. */
export function fakeXero(): FakeXero {
  let seq = 0;
  const next = (prefix: string): string => `${prefix}-${++seq}`;
  const fake: FakeXero = {
    calls: [],
    contacts: new Map(),
    invoices: new Map(),
    creditNotes: new Map(),
    failures: {},
    accounts: [],
    pdf: new Uint8Array([37, 80, 68, 70]),
    count: (method) => fake.calls.filter((c) => c.method === method).length,
    async findContactByEmail(email) {
      record("findContactByEmail", email);
      const id = fake.contacts.get(email);
      return id ? { contactId: id } : null;
    },
    async createContact(input) {
      record("createContact", input);
      const id = next("contact");
      if (input.email) fake.contacts.set(input.email, id);
      return { contactId: id };
    },
    async createInvoice(input) {
      record("createInvoice", input);
      const total = input.lines.reduce((sum, l) => sum + l.unitAmountCents * l.quantity, 0);
      const invoice = {
        invoiceId: next("inv"),
        invoiceNumber: `INV-${String(1000 + seq)}`,
        status: "AUTHORISED",
        totalCents: total,
        amountDueCents: total,
        amountPaidCents: 0,
        input,
      };
      fake.invoices.set(invoice.invoiceId, invoice);
      return invoice;
    },
    async getInvoice(invoiceId) {
      record("getInvoice", invoiceId);
      const invoice = fake.invoices.get(invoiceId);
      if (!invoice) throw new Error(`no invoice ${invoiceId}`);
      return invoice;
    },
    async getInvoicePdf(invoiceId) {
      record("getInvoicePdf", invoiceId);
      return fake.pdf;
    },
    async createPayment(input) {
      record("createPayment", input);
      const invoice = fake.invoices.get(input.invoiceId);
      if (invoice) settle(invoice, input.amountCents, "amountPaidCents");
      return { paymentId: next("pay") };
    },
    async createCreditNote(input) {
      record("createCreditNote", input);
      const total = input.lines.reduce((sum, l) => sum + l.unitAmountCents * l.quantity, 0);
      const id = next("cn");
      fake.creditNotes.set(id, { ...input, totalCents: total });
      return { creditNoteId: id, totalCents: total };
    },
    async allocateCreditNote(input) {
      record("allocateCreditNote", input);
      const invoice = fake.invoices.get(input.invoiceId);
      if (invoice) settle(invoice, input.amountCents, "amountPaidCents");
    },
    async refundCreditNote(input) {
      record("refundCreditNote", input);
      return { paymentId: next("refund") };
    },
    async listAccounts() {
      record("listAccounts", null);
      return fake.accounts;
    },
  };

  function record(method: Method, input: unknown): void {
    fake.calls.push({ method, input });
    const queue = fake.failures[method];
    const error = queue?.shift();
    if (error) throw error;
  }

  function settle(invoice: XeroInvoiceSummary, cents: number, field: "amountPaidCents"): void {
    invoice[field] += cents;
    invoice.amountDueCents -= cents;
    if (invoice.amountDueCents <= 0) invoice.status = "PAID";
  }
  return fake;
}

export const xeroTokens = (over: Partial<XeroTokens> = {}): XeroTokens => ({
  accessToken: "xat",
  refreshToken: "xrt",
  expiresAt: NOW.getTime() + 20 * 60_000,
  ...over,
});

/** Connected Xero account with the account codes a real setup would have. */
export async function seedXero(
  db: Db,
  businessId: string,
  syncState: Record<string, unknown> = {},
  tokens: XeroTokens = xeroTokens(),
) {
  return seedAccount(
    db,
    businessId,
    "xero",
    {
      externalAccountId: "tenant-1",
      syncState: {
        clearingAccountCode: "610",
        cashAccountCode: "090",
        eftposAccountCode: "091",
        tenantName: "Ryan Kennedy Hairdressing",
        ...syncState,
      },
    },
    tokens,
  );
}

export interface XeroTestDeps extends XeroConsumerDeps {
  sendInvoiceEmail: ReturnType<typeof vi.fn<NonNullable<XeroConsumerDeps["sendInvoiceEmail"]>>>;
}

export function xeroDeps(
  db: Db,
  fake: FakeXero,
  over: Partial<XeroConsumerDeps> = {},
): XeroTestDeps {
  return {
    db,
    env: testEnv(),
    now: fixedNow,
    log: silentLog,
    createPort: async () => fake,
    backoff: { sleep: async () => {} },
    sendInvoiceEmail: vi.fn<NonNullable<XeroConsumerDeps["sendInvoiceEmail"]>>(async () => {}),
    ...over,
  } as XeroTestDeps;
}

export function fakeXeroAuth(): XeroAuthPort & {
  refresh: ReturnType<typeof vi.fn<XeroAuthPort["refresh"]>>;
  exchangeCallback: ReturnType<typeof vi.fn<XeroAuthPort["exchangeCallback"]>>;
} {
  let n = 0;
  return {
    buildConsentUrl: vi.fn(
      async ({ state }) => `https://login.xero.com/identity/connect/authorize?state=${state}`,
    ),
    exchangeCallback: vi.fn(async () => ({
      tokens: xeroTokens(),
      tenants: [{ tenantId: "tenant-9", tenantName: "Demo Company (AU)" }],
    })),
    refresh: vi.fn<XeroAuthPort["refresh"]>(async () => {
      n += 1;
      return xeroTokens({
        accessToken: `new-at-${n}`,
        refreshToken: `new-rt-${n}`,
        expiresAt: NOW.getTime() + 30 * 60_000,
      });
    }),
  };
}
