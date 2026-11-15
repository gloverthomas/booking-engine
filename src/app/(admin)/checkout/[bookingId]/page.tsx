import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { Suspense } from "react";
import { z } from "zod";
import { CheckoutScreen } from "@/components/admin/calendar/CheckoutScreen";
import { Skeleton } from "@/components/admin/calendar/ui-shim";
import { getCheckoutView } from "@/server/admin/bookings";
import { getReadContext } from "@/server/admin/session";
import { getBusinessContext } from "@/server/admin/shared";

export const metadata: Metadata = { title: "Check out" };

export default function CheckoutPage(props: PageProps<"/checkout/[bookingId]">) {
  return (
    <Suspense fallback={<CheckoutFallback />}>
      <CheckoutContent params={props.params} />
    </Suspense>
  );
}

function CheckoutFallback() {
  return (
    <div className="mx-auto flex w-full max-w-lg flex-col gap-5 p-4 md:p-6" aria-busy>
      <Skeleton className="h-10 w-2/3" />
      <Skeleton className="h-48 w-full" />
      <Skeleton className="h-14 w-full" />
    </div>
  );
}

async function CheckoutContent({
  params,
}: {
  params: PageProps<"/checkout/[bookingId]">["params"];
}) {
  await connection();
  const { db, access } = await getReadContext("checkout");
  const { bookingId } = await params;
  if (!z.uuid().safeParse(bookingId).success) notFound();

  const [view, { timezone }] = await Promise.all([
    getCheckoutView(db, bookingId, access),
    getBusinessContext(db),
  ]);
  // A stylist opening a colleague's booking sees the same 404 as a booking that does not exist.
  if (!view) notFound();
  return <CheckoutScreen view={view} timezone={timezone} />;
}
