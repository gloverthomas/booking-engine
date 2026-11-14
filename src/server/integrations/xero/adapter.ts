import {
  AuthRevokedError,
  ProviderValidationError,
  RateLimitedError,
  TransientProviderError,
} from "../common/errors";
import type {
  LineAmountTypes,
  XeroAccount,
  XeroAuthPort,
  XeroInvoiceSummary,
  XeroLine,
  XeroPort,
  XeroTokens,
} from "./port";
import { XERO_SCOPES } from "./port";

/* -------------------------------------------------------------------------- */
/* Errors                                                                     */
/* -------------------------------------------------------------------------- */

interface XeroHttpError {
  message?: string;
  response?: {
    status?: number;
    headers?: Record<string, string | undefined>;
    data?: unknown;
  };
  body?: unknown;
}

/** Best-effort extraction of Xero's validation messages from an error body. */
function validationMessage(data: unknown): string | undefined {
  if (typeof data !== "object" || data === null) return undefined;
  const body = data as {
    Message?: string;
    Elements?: Array<{ ValidationErrors?: Array<{ Message?: string }> }>;
  };
  const nested = body.Elements?.flatMap((e) => e.ValidationErrors ?? [])
    .map((v) => v.Message)
    .filter(Boolean)
    .join("; ");
  return nested || body.Message;
}

/** Translate an xero-node (axios) failure into the neutral error taxonomy. */
export function mapXeroError(error: unknown): Error {
  if (typeof error !== "object" || error === null) {
    return new TransientProviderError(String(error));
  }
  const e = error as XeroHttpError;
  const status = Number(e.response?.status);
  const data = e.response?.data ?? e.body;
  const message = validationMessage(data) ?? e.message ?? "Xero API error";

  if (status === 429) {
    const retryAfter = Number(e.response?.headers?.["retry-after"]);
    return new RateLimitedError(message, Number.isFinite(retryAfter) ? retryAfter : 60, {
      cause: error,
    });
  }
  if (status === 401 || status === 403) return new AuthRevokedError(message, { cause: error });
  if (status >= 400 && status < 500) return new ProviderValidationError(message, { cause: error });
  return new TransientProviderError(message, { cause: error });
}

async function call<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    throw mapXeroError(error);
  }
}

/* -------------------------------------------------------------------------- */
/* Accounting port                                                            */
/* -------------------------------------------------------------------------- */

interface Result<T> {
  body: T;
}

interface XeroInvoiceModel {
  invoiceID?: string;
  invoiceNumber?: string;
  status?: string;
  total?: number;
  amountDue?: number;
  amountPaid?: number;
}

/** The slice of xero-node's AccountingApi we call. Real clients are cast to this. */
export interface AccountingApiLike {
  getContacts(
    tenantId: string,
    ifModifiedSince?: Date,
    where?: string,
  ): Promise<Result<{ contacts?: Array<{ contactID?: string }> }>>;
  createContacts(
    tenantId: string,
    contacts: { contacts: Array<Record<string, unknown>> },
    summarizeErrors?: boolean,
    idempotencyKey?: string,
  ): Promise<Result<{ contacts?: Array<{ contactID?: string }> }>>;
  createInvoices(
    tenantId: string,
    invoices: { invoices: Array<Record<string, unknown>> },
    summarizeErrors?: boolean,
    unitdp?: number,
    idempotencyKey?: string,
  ): Promise<Result<{ invoices?: XeroInvoiceModel[] }>>;
  getInvoice(
    tenantId: string,
    invoiceId: string,
    unitdp?: number,
  ): Promise<Result<{ invoices?: XeroInvoiceModel[] }>>;
  getInvoiceAsPdf(
    tenantId: string,
    invoiceId: string,
    options?: { headers: Record<string, string> },
  ): Promise<Result<Buffer>>;
  createPayment(
    tenantId: string,
    payment: Record<string, unknown>,
    idempotencyKey?: string,
  ): Promise<Result<{ payments?: Array<{ paymentID?: string }> }>>;
  createCreditNotes(
    tenantId: string,
    creditNotes: { creditNotes: Array<Record<string, unknown>> },
    summarizeErrors?: boolean,
    unitdp?: number,
    idempotencyKey?: string,
  ): Promise<Result<{ creditNotes?: Array<{ creditNoteID?: string; total?: number }> }>>;
  createCreditNoteAllocation(
    tenantId: string,
    creditNoteId: string,
    allocations: { allocations: Array<Record<string, unknown>> },
    summarizeErrors?: boolean,
    idempotencyKey?: string,
  ): Promise<Result<unknown>>;
  getAccounts(tenantId: string): Promise<
    Result<{
      accounts?: Array<{
        code?: string;
        name?: string;
        type?: string;
        status?: string;
        enablePaymentsToAccount?: boolean;
      }>;
    }>
  >;
}

const toDollars = (cents: number): number => Math.round(cents) / 100;
const toCents = (dollars: number | undefined): number => Math.round((dollars ?? 0) * 100);

function lineItems(lines: XeroLine[]): Array<Record<string, unknown>> {
  return lines.map((line) => ({
    description: line.description,
    quantity: line.quantity,
    unitAmount: toDollars(line.unitAmountCents),
    accountCode: line.accountCode,
    ...(line.taxType ? { taxType: line.taxType } : {}),
  }));
}

function summarise(invoice: XeroInvoiceModel | undefined): XeroInvoiceSummary {
  if (!invoice?.invoiceID) throw new TransientProviderError("Xero returned no invoice");
  return {
    invoiceId: invoice.invoiceID,
    invoiceNumber: invoice.invoiceNumber ?? "",
    status: invoice.status ?? "",
    totalCents: toCents(invoice.total),
    amountDueCents: toCents(invoice.amountDue),
    amountPaidCents: toCents(invoice.amountPaid),
  };
}

const AMOUNT_TYPES: Record<LineAmountTypes, string> = {
  NoTax: "NoTax",
  Inclusive: "Inclusive",
  Exclusive: "Exclusive",
};

/** Escape a value for use inside Xero's `where` string literal. */
export const escapeWhere = (value: string): string => value.replace(/["\\]/g, "");

export function buildXeroPort(tenantId: string, api: AccountingApiLike): XeroPort {
  return {
    async findContactByEmail(email) {
      const { body } = await call(() =>
        api.getContacts(tenantId, undefined, `EmailAddress=="${escapeWhere(email)}"`),
      );
      const id = body.contacts?.[0]?.contactID;
      return id ? { contactId: id } : null;
    },

    async createContact(input) {
      const contact: Record<string, unknown> = { name: input.name };
      if (input.email) contact.emailAddress = input.email;
      if (input.phone) contact.phones = [{ phoneType: "MOBILE", phoneNumber: input.phone }];
      const { body } = await call(() =>
        api.createContacts(tenantId, { contacts: [contact] }, true),
      );
      const id = body.contacts?.[0]?.contactID;
      if (!id) throw new TransientProviderError("Xero returned no contact");
      return { contactId: id };
    },

    async createInvoice(input) {
      const invoice = {
        type: "ACCREC",
        contact: { contactID: input.contactId },
        date: input.date,
        dueDate: input.dueDate,
        reference: input.reference,
        lineAmountTypes: AMOUNT_TYPES[input.lineAmountTypes],
        status: "AUTHORISED",
        lineItems: lineItems(input.lines),
      };
      const { body } = await call(() =>
        api.createInvoices(tenantId, { invoices: [invoice] }, true, 2, input.idempotencyKey),
      );
      return summarise(body.invoices?.[0]);
    },

    async getInvoice(invoiceId) {
      const { body } = await call(() => api.getInvoice(tenantId, invoiceId, 2));
      return summarise(body.invoices?.[0]);
    },

    async getInvoicePdf(invoiceId) {
      const { body } = await call(() =>
        api.getInvoiceAsPdf(tenantId, invoiceId, { headers: { Accept: "application/pdf" } }),
      );
      return new Uint8Array(body);
    },

    async createPayment(input) {
      const { body } = await call(() =>
        api.createPayment(
          tenantId,
          {
            invoice: { invoiceID: input.invoiceId },
            account: { code: input.accountCode },
            date: input.date,
            amount: toDollars(input.amountCents),
            reference: input.reference,
          },
          input.idempotencyKey,
        ),
      );
      const id = body.payments?.[0]?.paymentID;
      if (!id) throw new TransientProviderError("Xero returned no payment");
      return { paymentId: id };
    },

    async createCreditNote(input) {
      const creditNote = {
        type: "ACCRECCREDIT",
        contact: { contactID: input.contactId },
        date: input.date,
        reference: input.reference,
        lineAmountTypes: AMOUNT_TYPES[input.lineAmountTypes],
        status: "AUTHORISED",
        lineItems: lineItems(input.lines),
      };
      const { body } = await call(() =>
        api.createCreditNotes(
          tenantId,
          { creditNotes: [creditNote] },
          true,
          2,
          input.idempotencyKey,
        ),
      );
      const created = body.creditNotes?.[0];
      if (!created?.creditNoteID) throw new TransientProviderError("Xero returned no credit note");
      return { creditNoteId: created.creditNoteID, totalCents: toCents(created.total) };
    },

    async allocateCreditNote(input) {
      await call(() =>
        api.createCreditNoteAllocation(
          tenantId,
          input.creditNoteId,
          {
            allocations: [
              {
                invoice: { invoiceID: input.invoiceId },
                amount: toDollars(input.amountCents),
                date: input.date,
              },
            ],
          },
          true,
          input.idempotencyKey,
        ),
      );
    },

    async refundCreditNote(input) {
      const { body } = await call(() =>
        api.createPayment(
          tenantId,
          {
            creditNote: { creditNoteID: input.creditNoteId },
            account: { code: input.accountCode },
            date: input.date,
            amount: toDollars(input.amountCents),
            reference: input.reference,
          },
          input.idempotencyKey,
        ),
      );
      const id = body.payments?.[0]?.paymentID;
      if (!id) throw new TransientProviderError("Xero returned no refund payment");
      return { paymentId: id };
    },

    async listAccounts(): Promise<XeroAccount[]> {
      const { body } = await call(() => api.getAccounts(tenantId));
      return (body.accounts ?? [])
        .filter((a) => a.code)
        .map((a) => ({
          code: a.code!,
          name: a.name ?? "",
          type: String(a.type ?? ""),
          status: String(a.status ?? ""),
          enablePayments: a.enablePaymentsToAccount === true || a.type === "BANK",
        }));
    },
  };
}

export interface CreateXeroPortInput {
  tenantId: string;
  accessToken: string;
}

/** Real Xero client for one tenant. `xero-node` is imported lazily. */
export async function createXeroPort(input: CreateXeroPortInput): Promise<XeroPort> {
  const { XeroClient } = await import("xero-node");
  const client = new XeroClient();
  client.setTokenSet({ access_token: input.accessToken });
  return buildXeroPort(input.tenantId, client.accountingApi as unknown as AccountingApiLike);
}

/* -------------------------------------------------------------------------- */
/* OAuth port                                                                 */
/* -------------------------------------------------------------------------- */

export interface XeroClientConfig {
  clientId: string;
  clientSecret: string;
}

interface TokenSetLike {
  access_token?: string;
  refresh_token?: string;
  expires_at?: number;
  expires_in?: number;
  scope?: string;
}

const DEFAULT_ACCESS_TOKEN_MS = 30 * 60 * 1000;

export function tokensFrom(set: TokenSetLike, now: number = Date.now()): XeroTokens {
  if (!set.access_token || !set.refresh_token) {
    throw new AuthRevokedError("Xero did not return an access and refresh token");
  }
  const expiresAt = set.expires_at
    ? set.expires_at * 1000
    : now + (set.expires_in ? set.expires_in * 1000 : DEFAULT_ACCESS_TOKEN_MS);
  return {
    accessToken: set.access_token,
    refreshToken: set.refresh_token,
    expiresAt,
    scope: set.scope,
  };
}

/** A refresh that Xero refuses (invalid_grant, bad client) means the owner has to reconnect. */
export function mapRefreshError(error: unknown): Error {
  const mapped = mapXeroError(error);
  const e = error as XeroHttpError;
  const data = e?.response?.data as { error?: string } | undefined;
  if (data?.error === "invalid_grant" || data?.error === "invalid_client") {
    return new AuthRevokedError("Xero access was revoked or has expired", { cause: error });
  }
  const status = Number(e?.response?.status);
  if (status === 400 && !(mapped instanceof RateLimitedError)) {
    return new AuthRevokedError("Xero access was revoked or has expired", { cause: error });
  }
  return mapped;
}

export function createXeroAuthPort(config: XeroClientConfig): XeroAuthPort {
  const make = async (extra: { redirectUri: string; state: string } | null) => {
    const { XeroClient } = await import("xero-node");
    return new XeroClient({
      clientId: config.clientId,
      clientSecret: config.clientSecret,
      ...(extra
        ? { redirectUris: [extra.redirectUri], scopes: [...XERO_SCOPES], state: extra.state }
        : {}),
    });
  };

  return {
    async buildConsentUrl({ state, redirectUri }) {
      const client = await make({ redirectUri, state });
      return call(() => client.buildConsentUrl());
    },

    async exchangeCallback({ callbackUrl, state, redirectUri }) {
      const client = await make({ redirectUri, state });
      const set = await call(() => client.apiCallback(callbackUrl));
      const connections = await call(() => client.updateTenants(false));
      const tenants = (connections as Array<Record<string, string>>)
        .filter((c) => !c.tenantType || c.tenantType === "ORGANISATION")
        .map((c) => ({ tenantId: c.tenantId, tenantName: c.tenantName ?? "" }));
      return { tokens: tokensFrom(set), tenants };
    },

    async refresh(refreshToken) {
      const client = await make(null);
      try {
        const set = await client.refreshWithRefreshToken(
          config.clientId,
          config.clientSecret,
          refreshToken,
        );
        return tokensFrom(set);
      } catch (error) {
        throw mapRefreshError(error);
      }
    },
  };
}
