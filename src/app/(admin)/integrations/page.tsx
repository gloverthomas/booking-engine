import { PageBoundary } from "@/components/admin/shell/page-boundary";
import type { Metadata } from "next";
import { DateTime } from "luxon";
import { getDb } from "@/db/client";
import { getEnv } from "@/lib/env";
import { Alert } from "@/components/ui/alert";
import { Badge, type BadgeTone } from "@/components/ui/badge";
import { buttonClasses } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { GoogleCalendarControl } from "@/components/admin/staff/GoogleCalendarControl";
import { toStaffRowViews } from "@/components/admin/staff/views";
import { PageHeader } from "@/components/ui/page-header";
import { getBusiness } from "@/server/admin-foundation/business";
import {
  configuredProvidersFromEnv,
  getIntegrationCards,
  listGoogleByStylist,
  type IntegrationCard,
  type IntegrationCardStatus,
} from "@/server/admin-foundation/integrations";
import { requireAccess } from "@/server/auth/access";

export const metadata: Metadata = { title: "Integrations" };

const STATUS: Record<IntegrationCardStatus, { label: string; tone: BadgeTone }> = {
  connected: { label: "Connected", tone: "success" },
  error: { label: "Needs attention", tone: "danger" },
  disconnected: { label: "Not connected", tone: "neutral" },
  not_configured: { label: "Not set up", tone: "warning" },
};

export default function IntegrationsPage() {
  return (
    <PageBoundary>
      <IntegrationsBody />
    </PageBoundary>
  );
}

async function IntegrationsBody() {
  await requireAccess("integrations.manage");
  const db = getDb();
  const env = getEnv();
  const [biz, cards, stylists] = await Promise.all([
    getBusiness(db),
    getIntegrationCards(db, configuredProvidersFromEnv(env)),
    listGoogleByStylist(db),
  ]);
  const googleConfigured = Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET);
  const people = toStaffRowViews(stylists, biz.timezone);

  const formatTime = (date: Date) =>
    DateTime.fromJSDate(date, { zone: biz.timezone }).toFormat("ccc d LLL yyyy, h:mm a");

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        eyebrow="Integrations"
        title="Connections"
        description="Stripe takes payments, Google keeps your calendar in sync and Xero receives invoices."
      />
      <ul className="grid gap-4 lg:grid-cols-3">
        {cards.map((card) => (
          <li key={card.provider} className="flex">
            <IntegrationCardView card={card} formatTime={formatTime} />
          </li>
        ))}
      </ul>

      <section aria-labelledby="google-by-stylist" className="flex flex-col gap-3">
        <div>
          <h2 id="google-by-stylist" className="display text-2xl">
            Google Calendar by stylist
          </h2>
          <p className="text-sm text-ink-muted">
            Each person links their own calendar, so their bookings land in their own Google
            diary. You can also manage this from Staff.
          </p>
        </div>
        <ul className="grid gap-4 lg:grid-cols-2">
          {people.map((person) => (
            <li key={person.id}>
              <Card aria-labelledby={`g-${person.id}`}>
                <CardBody className="flex flex-col gap-3">
                  <p id={`g-${person.id}`} className="text-base font-bold">
                    {person.name}
                  </p>
                  <GoogleCalendarControl
                    staffId={person.id}
                    google={person.google}
                    configured={googleConfigured}
                  />
                </CardBody>
              </Card>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

function IntegrationCardView({
  card,
  formatTime,
}: {
  card: IntegrationCard;
  formatTime: (date: Date) => string;
}) {
  const status = STATUS[card.status];
  const labelId = `integration-${card.provider}`;
  const actionLabel = card.status === "connected" ? "Reconnect" : "Connect";
  return (
    <Card aria-labelledby={labelId} className="flex w-full flex-col">
      <CardHeader
        title={<span id={labelId}>{card.label}</span>}
        actions={<Badge tone={status.tone}>{status.label}</Badge>}
      />
      <CardBody className="flex flex-1 flex-col gap-4">
        <p className="text-sm text-ink-muted">{card.description}</p>

        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
          <dt className="text-ink-subtle">Account</dt>
          <dd className="truncate">{card.externalAccountId ?? "—"}</dd>
          <dt className="text-ink-subtle">Last sync</dt>
          <dd>{card.lastSyncAt ? formatTime(card.lastSyncAt) : "Never"}</dd>
        </dl>

        {card.lastError ? (
          <Alert tone="danger" title="Last error">
            {card.lastError}
          </Alert>
        ) : null}
        {card.status === "not_configured" ? (
          <Alert tone="warning">
            {card.provider === "stripe"
              ? "Add the Stripe API keys to the server environment to take payments."
              : `Add the ${card.label} credentials to the server environment, then connect.`}
          </Alert>
        ) : null}

        {card.connectHref ? (
          // A plain anchor: the connect route redirects to the provider, so it must be a full navigation.
          <a
            href={card.connectHref}
            className={buttonClasses({
              variant: card.status === "connected" ? "secondary" : "primary",
              fullWidth: true,
            })}
          >
            {actionLabel} {card.label}
          </a>
        ) : null}
      </CardBody>
    </Card>
  );
}
