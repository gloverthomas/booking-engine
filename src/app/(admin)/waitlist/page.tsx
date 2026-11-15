import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { Suspense } from "react";
import { getDb } from "@/db/client";
import { Badge, ButtonLink, EmptyState, PageHeader } from "@/components/ui";
import { getBusiness } from "@/server/admin-foundation/business";
import { requireAccess } from "@/server/auth/access";
import { parseSettings } from "@/server/settings";
import { listWaitlist, type AdminEntryRow } from "@/server/waitlist";
import { describeTimeOfDay, describeWeekdays } from "@/server/waitlist/window";
import { RemoveEntryButton } from "./_components/EntryActions";
import { STATUS_LABEL, STATUS_TONE, ageLabel, dayLabel, whenLabel } from "./_components/format";

export const metadata: Metadata = { title: "Waitlist" };

export default function WaitlistPage(props: PageProps<"/waitlist">) {
  return (
    <Suspense
      fallback={
        <p className="p-6" role="status">
          Loading the waitlist…
        </p>
      }
    >
      <WaitlistContent searchParams={props.searchParams} />
    </Suspense>
  );
}

async function WaitlistContent({
  searchParams,
}: {
  searchParams: PageProps<"/waitlist">["searchParams"];
}) {
  await connection();
  await requireAccess("waitlist.manage");
  const raw = await searchParams;
  const view = raw.view === "history" ? "history" : "active";
  const db = getDb();
  const [rows, business] = await Promise.all([listWaitlist(db, view), getBusiness(db)]);
  const settings = parseSettings(business.settings);
  const now = new Date();

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 p-3 md:p-6">
      <PageHeader
        title="Waitlist"
        eyebrow={view === "active" ? `${rows.length} waiting` : "History"}
        description={
          !settings.waitlistEnabled
            ? "The waitlist is switched off, so clients cannot join. You can still offer times to people already on it."
            : settings.waitlistAutoOffer
              ? `Freed times are offered automatically to up to ${settings.waitlistMaxOffersPerSlot} people at once, held for ${settings.waitlistOfferWindowMin} minutes. First to pay the deposit wins. You can also offer a time yourself.`
              : "Automatic offers are off. Offer freed times to people yourself."
        }
        actions={
          <ButtonLink
            href={view === "active" ? "/waitlist?view=history" : "/waitlist"}
            variant="secondary"
          >
            {view === "active" ? "See history" : "Back to waiting"}
          </ButtonLink>
        }
      />

      {rows.length === 0 ? (
        <EmptyState
          title={view === "active" ? "Nobody is waiting" : "No history yet"}
          description={
            view === "active"
              ? "When a day has no times, clients can ask to be told if one opens up. They will show here."
              : "Entries that were booked, removed or ran out appear here."
          }
        />
      ) : (
        <ul className="flex flex-col gap-3">
          {rows.map((row) => (
            <EntryCard key={row.id} row={row} timezone={business.timezone} now={now} />
          ))}
        </ul>
      )}
    </div>
  );
}

function EntryCard({ row, timezone, now }: { row: AdminEntryRow; timezone: string; now: Date }) {
  const canOffer = row.status === "waiting" || row.status === "offered";
  return (
    <li className="flex flex-col gap-3 rounded-card border border-line bg-surface p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-lg font-semibold">
            <Link className="underline-offset-4 hover:underline" href={`/clients/${row.clientId}`}>
              {row.clientName}
            </Link>
          </h2>
          <p className="text-sm text-ink-muted">
            {[row.clientPhone, row.clientEmail].filter(Boolean).join(" · ") || "No contact details"}
          </p>
        </div>
        <Badge tone={STATUS_TONE[row.status]}>{STATUS_LABEL[row.status]}</Badge>
      </div>

      <dl className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
        <div>
          <dt className="sr-only">Services</dt>
          <dd className="font-medium">{row.serviceNames.join(" + ")}</dd>
        </div>
        <div>
          <dt className="sr-only">Where and who</dt>
          <dd>
            {row.locationName} · {row.staffName ?? "Any stylist"}
          </dd>
        </div>
        <div>
          <dt className="sr-only">Window</dt>
          <dd>
            {dayLabel(row.earliestDate)} to {dayLabel(row.latestDate)} ·{" "}
            {describeWeekdays(row.weekdays)} · {describeTimeOfDay(row)}
          </dd>
        </div>
        <div>
          <dt className="sr-only">Waiting for</dt>
          <dd className="text-ink-muted">Waiting {ageLabel(row.createdAt, now)}</dd>
        </div>
        {row.notes ? (
          <div className="sm:col-span-2">
            <dt className="sr-only">Notes</dt>
            <dd className="text-ink-muted">{row.notes}</dd>
          </div>
        ) : null}
      </dl>

      {row.offers.length > 0 ? (
        <div>
          <h3 className="text-xs font-semibold uppercase tracking-[0.09em] text-ink-subtle">
            Offers
          </h3>
          <ul className="mt-1 flex flex-col gap-1 text-sm">
            {row.offers.slice(0, 5).map((offer) => (
              <li key={offer.id} className="flex flex-wrap items-center gap-2">
                <Badge tone={STATUS_TONE[offer.status]}>{STATUS_LABEL[offer.status]}</Badge>
                <span>
                  {whenLabel(offer.start, timezone)} with {offer.staffName}
                </span>
                <span className="text-ink-muted">
                  {offer.offeredBy === "auto" ? "automatic" : "by hand"}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {canOffer ? (
        <div className="flex flex-wrap items-center gap-2">
          <ButtonLink href={`/waitlist/${row.id}/offer`} size="sm">
            Offer a time
          </ButtonLink>
          <RemoveEntryButton entryId={row.id} name={row.clientName} />
        </div>
      ) : null}
    </li>
  );
}
