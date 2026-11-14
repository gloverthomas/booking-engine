import { integrationAccount } from "@/db/schema";
import type { Env } from "@/lib/env";
import type { Db } from "@/server/db-types";

export type IntegrationProviderId = "stripe" | "google" | "xero";
export type IntegrationCardStatus = "connected" | "error" | "disconnected" | "not_configured";

export interface IntegrationCard {
  provider: IntegrationProviderId;
  label: string;
  description: string;
  status: IntegrationCardStatus;
  externalAccountId: string | null;
  lastSyncAt: Date | null;
  lastError: string | null;
  /** Where the connect / reconnect button goes (built by the integrations workstream). Null when not applicable. */
  connectHref: string | null;
}

const CARDS: ReadonlyArray<{
  provider: IntegrationProviderId;
  label: string;
  description: string;
  connectHref: string | null;
}> = [
  {
    provider: "stripe",
    label: "Stripe",
    description: "Card payments, deposits and refunds. Configured with API keys on the server.",
    connectHref: null,
  },
  {
    provider: "google",
    label: "Google Calendar",
    description: "Two-way sync so bookings appear in Google and busy time blocks the diary.",
    connectHref: "/api/integrations/google/connect",
  },
  {
    provider: "xero",
    label: "Xero",
    description: "Contacts, invoices and payments pushed to your accounts automatically.",
    connectHref: "/api/integrations/xero/connect",
  },
];

export function configuredProvidersFromEnv(env: Env): Record<IntegrationProviderId, boolean> {
  return {
    stripe: Boolean(env.STRIPE_SECRET_KEY),
    google: Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET),
    xero: Boolean(env.XERO_CLIENT_ID && env.XERO_CLIENT_SECRET),
  };
}

/** Status cards for the integrations page. Reads integration_account but never selects the encrypted tokens. */
export async function getIntegrationCards(
  db: Db,
  configured: Record<IntegrationProviderId, boolean>,
): Promise<IntegrationCard[]> {
  const rows = await db
    .select({
      provider: integrationAccount.provider,
      status: integrationAccount.status,
      externalAccountId: integrationAccount.externalAccountId,
      lastSyncAt: integrationAccount.lastSyncAt,
      lastError: integrationAccount.lastError,
    })
    .from(integrationAccount);

  return CARDS.map((card) => {
    const row = rows.find((r) => r.provider === card.provider);
    const isConfigured = configured[card.provider];
    let status: IntegrationCardStatus;
    if (!isConfigured) status = "not_configured";
    else if (row) status = row.status;
    else status = card.provider === "stripe" ? "connected" : "disconnected";
    return {
      ...card,
      status,
      externalAccountId: row?.externalAccountId ?? null,
      lastSyncAt: row?.lastSyncAt ?? null,
      lastError: row?.lastError ?? null,
      connectHref: isConfigured ? card.connectHref : null,
    };
  });
}
