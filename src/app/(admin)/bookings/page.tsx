import type { Metadata } from "next";
import { connection } from "next/server";
import { Suspense } from "react";
import { z } from "zod";
import { BookingsList } from "@/components/admin/calendar/BookingsList";
import { Skeleton } from "@/components/admin/calendar/ui-shim";
import { listBookings } from "@/server/admin/bookings";
import { getCalendarReadContext } from "@/server/admin/session";
import { getBusinessContext } from "@/server/admin/shared";

export const metadata: Metadata = { title: "Bookings" };

const LIMIT = 100;

const searchSchema = z.object({
  view: z.enum(["upcoming", "past", "cancelled"]).catch("upcoming"),
  q: z.string().trim().max(100).catch(""),
});

export default function BookingsPage(props: PageProps<"/bookings">) {
  return (
    <Suspense fallback={<BookingsFallback />}>
      <BookingsContent searchParams={props.searchParams} />
    </Suspense>
  );
}

function BookingsFallback() {
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 p-3 md:p-6" aria-busy>
      <Skeleton className="h-8 w-40" />
      <Skeleton className="h-11 w-full" />
      <Skeleton className="h-11 w-full" />
      <Skeleton className="h-24 w-full" />
    </div>
  );
}

async function BookingsContent({
  searchParams,
}: {
  searchParams: PageProps<"/bookings">["searchParams"];
}) {
  await connection();
  const { db, access, caps } = await getCalendarReadContext();
  const raw = await searchParams;
  const { view, q } = searchSchema.parse({
    view: typeof raw.view === "string" ? raw.view : undefined,
    q: typeof raw.q === "string" ? raw.q : "",
  });
  const [rows, { timezone }] = await Promise.all([
    listBookings(db, access, { filter: view, q, limit: LIMIT }),
    getBusinessContext(db),
  ]);
  return (
    <BookingsList
      rows={rows}
      filter={view}
      q={q}
      timezone={timezone}
      limit={LIMIT}
      showStylist={caps.seesAll}
    />
  );
}
