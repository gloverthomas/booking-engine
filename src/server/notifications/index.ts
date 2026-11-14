import type { Db } from "../db-types";

/**
 * OWNER: workstream F (notifications). Other modules mostly react through events
 * (src/server/events.ts); these are the direct calls they may make. Replace the stubs, keep signatures.
 */

/** Admin action: send the confirmation email and SMS again. */
export async function resendConfirmation(_db: Db, _bookingId: string): Promise<void> {
  throw new Error("resendConfirmation not implemented");
}

/** Admin / MCP action: a one-off message to a client. */
export async function sendOneOffMessage(
  _db: Db,
  _input: { clientId: string; channel: "email" | "sms"; subject?: string; body: string },
): Promise<void> {
  throw new Error("sendOneOffMessage not implemented");
}

/** Called by the Xero handler once the invoice exists: emails the invoice PDF to the client. */
export async function sendInvoiceEmail(
  _db: Db,
  _input: { bookingId: string; invoiceNumber: string; pdf: Uint8Array },
): Promise<void> {
  throw new Error("sendInvoiceEmail not implemented");
}
