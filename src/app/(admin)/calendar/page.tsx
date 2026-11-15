import type { Metadata } from "next";
import { connection } from "next/server";
import { Suspense } from "react";
import { CalendarApp } from "@/components/admin/calendar/CalendarApp";
import { Skeleton } from "@/components/admin/calendar/ui-shim";
import { listCalendarResources } from "@/server/admin/calendar";
import { getCalendarReadContext } from "@/server/admin/session";

export const metadata: Metadata = { title: "Calendar" };

export default function CalendarPage() {
  return (
    <Suspense fallback={<CalendarFallback />}>
      <CalendarContent />
    </Suspense>
  );
}

function CalendarFallback() {
  return (
    <div className="flex h-[calc(100dvh-4rem)] min-h-[32rem] flex-col gap-3 p-3 md:p-4" aria-busy>
      <Skeleton className="h-11 w-full" />
      <Skeleton className="h-11 w-2/3" />
      <Skeleton className="min-h-0 flex-1" />
    </div>
  );
}

async function CalendarContent() {
  // Opt this render into request time so nothing touches the database during the build.
  await connection();
  const { db, access } = await getCalendarReadContext();
  const resources = await listCalendarResources(db, access);
  return <CalendarApp resources={resources} />;
}
