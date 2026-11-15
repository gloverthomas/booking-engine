import { isNull } from "drizzle-orm";
import { integrationAccount } from "@/db/schema";
import type { Env } from "@/lib/env";
import type { Db } from "@/server/db-types";
import { listStaff, type StaffListItem } from "@/server/staff/queries";

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
    description:
      "Two-way sync so bookings appear in Google and busy time blocks the diary. Each stylist links their own calendar.",
    // Per stylist: the connect links live on each person (see listGoogleByStylist and /staff).
    connectHref: null,
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

/** One row per active team member with their Google Calendar status, for the integrations page. */
export async function listGoogleByStylist(db: Db): Promise<StaffListItem[]> {
  return (await listStaff(db)).filter((person) => person.active);
}

/** Roll the per-stylist Google links into one card status: any error wins, then any connected. */
function googleCardStatus(
  people: readonly StaffListItem[],
): { status: IntegrationCardStatus; lastSyncAt: Date | null; lastError: string | null } {
  const links = people.flatMap((p) => (p.google ? [p.google] : []));
  const errored = links.find((l) => l.status === "error");
  const connected = links.filter((l) => l.status === "connected");
  const lastSyncAt =
    links
      .map((l) => l.lastSyncAt)
      .filter((d): d is Date => d !== null)
      .sort((a, b) => b.getTime() - a.getTime())[0] ?? null;
  if (errored) return { status: "error", lastSyncAt, lastError: errored.lastError };
  return { status: connected.length > 0 ? "connected" : "disconnected", lastSyncAt, lastError: null };
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
    .from(integrationAccount)
    // Stripe and Xero are business-wide; Google links belong to people (see below).
    .where(isNull(integrationAccount.staffId));
  const google = googleCardStatus(await listGoogleByStylist(db));

  return CARDS.map((card) => {
    const row = rows.find((r) => r.provider === card.provider);
    const isConfigured = configured[card.provider];
    if (card.provider === "google") {
      return {
        ...card,
        status: isConfigured ? google.status : "not_configured",
        externalAccountId: null,
        lastSyncAt: google.lastSyncAt,
        lastError: google.lastError,
        connectHref: null,
      };
    }
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
