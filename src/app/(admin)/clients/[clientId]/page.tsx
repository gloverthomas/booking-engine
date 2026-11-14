import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { connection } from "next/server";
import { Suspense } from "react";
import { z } from "zod";
import { getDb } from "@/db/client";
import { ClientProfile } from "@/components/admin/clients/ClientProfile";
import { Skeleton } from "@/components/admin/calendar/ui-shim";
import { getClientProfile } from "@/server/admin/clients";
import { getBusinessContext } from "@/server/admin/shared";
import { requireOwner } from "@/server/auth";

export const metadata: Metadata = { title: "Client" };

export default function ClientPage(props: PageProps<"/clients/[clientId]">) {
  return (
    <Suspense fallback={<ClientFallback />}>
      <ClientContent params={props.params} />
    </Suspense>
  );
}

function ClientFallback() {
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 p-3 md:p-6" aria-busy>
      <Skeleton className="h-9 w-48" />
      <Skeleton className="h-24 w-full" />
      <Skeleton className="h-40 w-full" />
    </div>
  );
}

async function ClientContent({ params }: { params: PageProps<"/clients/[clientId]">["params"] }) {
  await connection();
  await requireOwner();
  const { clientId } = await params;
  if (!z.uuid().safeParse(clientId).success) notFound();

  const db = getDb();
  const [profile, { timezone }] = await Promise.all([
    getClientProfile(db, clientId),
    getBusinessContext(db),
  ]);
  if (!profile) notFound();
  // A merged-away record sends you to the client it became.
  if (profile.mergedIntoId) redirect(`/clients/${profile.mergedIntoId}`);

  return <ClientProfile profile={profile} timezone={timezone} />;
}
