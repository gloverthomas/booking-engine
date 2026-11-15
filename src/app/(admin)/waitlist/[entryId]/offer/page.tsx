import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { Suspense } from "react";
import { getDb } from "@/db/client";
import { ButtonLink, EmptyState, PageHeader } from "@/components/ui";
import { NotFoundError } from "@/server/booking/errors";
import { requireAccess } from "@/server/auth/access";
import { listOfferableSlots } from "@/server/waitlist";
import { OfferSlotButton } from "../../_components/OfferSlotButton";
import { dayLabel, whenLabel } from "../../_components/format";

export const metadata: Metadata = { title: "Offer a time" };

export default function OfferPage(props: PageProps<"/waitlist/[entryId]/offer">) {
  return (
    <Suspense
      fallback={
        <p className="p-6" role="status">
          Finding open times…
        </p>
      }
    >
      <OfferContent params={props.params} />
    </Suspense>
  );
}

async function OfferContent({
  params,
}: {
  params: PageProps<"/waitlist/[entryId]/offer">["params"];
}) {
  await connection();
  await requireAccess("waitlist.manage");
  const { entryId } = await params;

  let result;
  try {
    result = await listOfferableSlots(getDb(), entryId, new Date());
  } catch (error) {
    if (error instanceof NotFoundError) notFound();
    throw error;
  }
  const { entry, slots, timezone } = result;

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 p-3 md:p-6">
      <PageHeader
        eyebrow="Waitlist"
        title={`Offer a time to ${entry.clientName}`}
        description={`${entry.serviceNames.join(" + ")} at ${entry.locationName}, ${dayLabel(entry.earliestDate)} to ${dayLabel(entry.latestDate)}. They get a message with a link; first to pay the deposit gets the time.`}
        actions={
          <ButtonLink href="/waitlist" variant="secondary">
            Back
          </ButtonLink>
        }
      />
      {slots.length === 0 ? (
        <EmptyState
          title="No open times match"
          description="There is nothing open inside their dates, days and hours right now. Check again after a cancellation."
        />
      ) : (
        <ul className="flex flex-col gap-2">
          {slots.map((slot) => {
            const label = `${whenLabel(slot.start, timezone)} with ${slot.staffName}`;
            return (
              <li
                key={`${slot.staffId}-${slot.start.toISOString()}`}
                className="flex min-h-14 items-center justify-between gap-3 rounded-card border border-line bg-surface px-4 py-2"
              >
                <span>
                  <span className="block font-medium">{whenLabel(slot.start, timezone)}</span>
                  <span className="block text-sm text-ink-muted">{slot.staffName}</span>
                </span>
                <OfferSlotButton
                  entryId={entry.id}
                  staffId={slot.staffId}
                  start={slot.start.toISOString()}
                  end={slot.end.toISOString()}
                  label={label}
                />
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
