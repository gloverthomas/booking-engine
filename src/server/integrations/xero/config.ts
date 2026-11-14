import { z } from "zod";
import type { AccountRow } from "../common/account-store";
import { NotConfiguredError } from "../common/errors";

/**
 * Accounting choices, stored at the top level of integration_account.sync_state for provider
 * 'xero'. The defaults suit a sole trader who is not registered for GST.
 */
export const xeroConfigSchema = z.object({
  /** Sales account every service line is booked to. */
  revenueAccountCode: z.string().trim().min(1).default("200"),
  /** Where Stripe deposits land until the payout arrives. Must allow payments in Xero. */
  clearingAccountCode: z.string().trim().min(1).optional(),
  cashAccountCode: z.string().trim().min(1).optional(),
  eftposAccountCode: z.string().trim().min(1).optional(),
  /**
   * 'NONE': no GST, invoices carry no tax (LineAmountTypes NoTax).
   * 'OUTPUT': GST-registered; amounts are GST-inclusive and lines use Xero's "GST on Income".
   */
  taxType: z.enum(["NONE", "OUTPUT"]).default("NONE"),
  /** On cancel/no-show, credit the unpaid balance so revenue equals what was actually kept. */
  writeOffOnCancel: z.boolean().default(true),
  /** Email the invoice PDF to the client once the invoice exists. */
  emailInvoice: z.boolean().default(true),
});

const code = z.string().trim().min(1);

/** PATCH body: every field optional, no defaults (so unspecified keys are left untouched). Null clears a code. */
export const xeroConfigPatchSchema = z
  .object({
    revenueAccountCode: code,
    clearingAccountCode: code.nullable(),
    cashAccountCode: code.nullable(),
    eftposAccountCode: code.nullable(),
    taxType: z.enum(["NONE", "OUTPUT"]),
    writeOffOnCancel: z.boolean(),
    emailInvoice: z.boolean(),
  })
  .partial()
  .strict();

export type XeroConfig = z.infer<typeof xeroConfigSchema>;

/** Keys of XeroConfig, so route handlers can pick them out of sync_state / request bodies. */
export const XERO_CONFIG_KEYS = Object.keys(xeroConfigSchema.shape) as Array<keyof XeroConfig>;

export function readXeroConfig(account: AccountRow): XeroConfig {
  const picked: Record<string, unknown> = {};
  for (const key of XERO_CONFIG_KEYS) {
    const value = account.syncState[key];
    if (value !== null && value !== undefined) picked[key] = value;
  }
  const parsed = xeroConfigSchema.safeParse(picked);
  return parsed.success ? parsed.data : xeroConfigSchema.parse({});
}

export type PaymentMethod = "stripe_online" | "stripe_in_person" | "cash" | "eftpos" | "other";

/** Which Xero account money in (or out, for refunds) of this method moves through. */
export function accountCodeForMethod(method: PaymentMethod, config: XeroConfig): string {
  const code =
    method === "cash"
      ? config.cashAccountCode
      : method === "eftpos"
        ? config.eftposAccountCode
        : config.clearingAccountCode;
  if (!code) {
    const setting =
      method === "cash"
        ? "cashAccountCode"
        : method === "eftpos"
          ? "eftposAccountCode"
          : "clearingAccountCode";
    throw new NotConfiguredError(
      `Xero ${setting} is not set. Choose the account in the Xero integration settings.`,
    );
  }
  return code;
}
