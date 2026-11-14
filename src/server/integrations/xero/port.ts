/**
 * The narrow slice of the Xero Accounting API this app uses, bound to one organisation
 * (tenant) and one access token. `adapter.ts` implements it with `xero-node`; tests use fakes.
 * Money crosses this boundary as integer cents; the adapter converts to Xero's decimal dollars.
 *
 * Adapters throw the errors in ../common/errors: RateLimitedError (429, with Retry-After),
 * AuthRevokedError (401/403), ProviderValidationError (other 4xx), TransientProviderError
 * (5xx and network).
 */

/** "NoTax" for GST-unregistered businesses, "Inclusive" when GST is charged on tax-inclusive prices. */
export type LineAmountTypes = "NoTax" | "Inclusive" | "Exclusive";

export interface XeroLine {
  description: string;
  quantity: number;
  unitAmountCents: number;
  accountCode: string;
  /** Omitted for NoTax documents. */
  taxType?: string;
}

export interface XeroContactInput {
  name: string;
  email?: string;
  phone?: string;
}

export interface XeroInvoiceInput {
  contactId: string;
  /** Our booking id, so the invoice can be traced back. */
  reference: string;
  /** YYYY-MM-DD */
  date: string;
  dueDate: string;
  lines: XeroLine[];
  lineAmountTypes: LineAmountTypes;
  idempotencyKey: string;
}

export interface XeroInvoiceSummary {
  invoiceId: string;
  invoiceNumber: string;
  status: string;
  totalCents: number;
  amountDueCents: number;
  amountPaidCents: number;
}

export interface XeroCreditNoteInput {
  contactId: string;
  reference: string;
  date: string;
  lines: XeroLine[];
  lineAmountTypes: LineAmountTypes;
  idempotencyKey: string;
}

export interface XeroAccount {
  code: string;
  name: string;
  type: string;
  status: string;
  /** Xero only accepts payments into accounts flagged for payments (bank accounts always are). */
  enablePayments: boolean;
}

export interface XeroPort {
  findContactByEmail(email: string): Promise<{ contactId: string } | null>;
  createContact(input: XeroContactInput): Promise<{ contactId: string }>;

  /** Creates an AUTHORISED ACCREC invoice. */
  createInvoice(input: XeroInvoiceInput): Promise<XeroInvoiceSummary>;
  getInvoice(invoiceId: string): Promise<XeroInvoiceSummary>;
  /** The invoice as a PDF (Accept: application/pdf). */
  getInvoicePdf(invoiceId: string): Promise<Uint8Array>;

  createPayment(input: {
    invoiceId: string;
    accountCode: string;
    amountCents: number;
    date: string;
    reference: string;
    idempotencyKey: string;
  }): Promise<{ paymentId: string }>;

  /** Creates an AUTHORISED ACCREC credit note. */
  createCreditNote(
    input: XeroCreditNoteInput,
  ): Promise<{ creditNoteId: string; totalCents: number }>;
  /** Applies (part of) a credit note against an invoice. */
  allocateCreditNote(input: {
    creditNoteId: string;
    invoiceId: string;
    amountCents: number;
    date: string;
    idempotencyKey: string;
  }): Promise<void>;
  /** Pays a credit note out: money leaves `accountCode` and goes back to the customer. */
  refundCreditNote(input: {
    creditNoteId: string;
    accountCode: string;
    amountCents: number;
    date: string;
    reference: string;
    idempotencyKey: string;
  }): Promise<{ paymentId: string }>;

  listAccounts(): Promise<XeroAccount[]>;
}

export interface XeroTokens {
  accessToken: string;
  refreshToken: string;
  /** Epoch ms when the access token expires (30 minutes after issue). */
  expiresAt: number;
  scope?: string;
}

export interface XeroTenant {
  tenantId: string;
  tenantName: string;
}

export interface XeroAuthPort {
  buildConsentUrl(input: { state: string; redirectUri: string }): Promise<string>;
  /** Exchanges the callback URL (with ?code and ?state) for tokens and lists the connected organisations. */
  exchangeCallback(input: {
    callbackUrl: string;
    state: string;
    redirectUri: string;
  }): Promise<{ tokens: XeroTokens; tenants: XeroTenant[] }>;
  /** Single-use: the returned refresh token replaces the one passed in. */
  refresh(refreshToken: string): Promise<XeroTokens>;
}

/** Granular scopes (apps created after 2 March 2026 cannot use accounting.transactions). */
export const XERO_SCOPES = [
  "offline_access",
  "accounting.contacts",
  "accounting.invoices",
  "accounting.payments",
  "accounting.settings.read",
] as const;
