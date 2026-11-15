import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { Suspense } from "react";
import { z } from "zod";
import { Badge, Button, Input, Skeleton } from "@/components/admin/calendar/ui-shim";
import { searchClients } from "@/server/admin/clients";
import { getReadContext } from "@/server/admin/session";

export const metadata: Metadata = { title: "Clients" };

const LIMIT = 100;
const querySchema = z.string().trim().max(100).catch("");

export default function ClientsPage(props: PageProps<"/clients">) {
  return (
    <Suspense fallback={<ClientsFallback />}>
      <ClientsContent searchParams={props.searchParams} />
    </Suspense>
  );
}

function ClientsFallback() {
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 p-3 md:p-6" aria-busy>
      <Skeleton className="h-8 w-32" />
      <Skeleton className="h-11 w-full" />
      <Skeleton className="h-16 w-full" />
      <Skeleton className="h-16 w-full" />
    </div>
  );
}

async function ClientsContent({
  searchParams,
}: {
  searchParams: PageProps<"/clients">["searchParams"];
}) {
  await connection();
  const { db, access } = await getReadContext("clients.view");
  const raw = await searchParams;
  const q = querySchema.parse(typeof raw.q === "string" ? raw.q : "");
  const clients = await searchClients(db, access, { q, limit: LIMIT });

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 p-3 md:p-6">
      <h1 className="text-2xl font-semibold">Clients</h1>

      <form action="/clients" method="get" role="search" className="flex gap-2">
        <Input
          type="search"
          name="q"
          defaultValue={q}
          placeholder="Search name, phone or email"
          aria-label="Search clients"
        />
        <Button type="submit" variant="secondary">
          Search
        </Button>
      </form>

      {clients.length === 0 ? (
        <p className="rounded-xl border border-dashed border-stone-300 p-6 text-center text-sm text-stone-600">
          {q ? `No clients match "${q}".` : "No clients yet."}
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {clients.map((c) => (
            <li key={c.id}>
              <Link
                href={`/clients/${c.id}`}
                className="flex min-h-16 items-center justify-between gap-3 rounded-xl border border-stone-200 bg-white px-4 py-3 hover:bg-stone-50 focus-visible:outline-2 focus-visible:outline-stone-900"
              >
                <span className="min-w-0">
                  <span className="block truncate font-medium">{c.name}</span>
                  <span className="block truncate text-sm text-stone-600">
                    {[c.phone, c.email].filter(Boolean).join(" · ") || "No contact details"}
                  </span>
                </span>
                <span className="flex shrink-0 gap-1">
                  {c.isVip ? <Badge tone="info">VIP</Badge> : null}
                  {c.blocked ? <Badge tone="bad">Blocked</Badge> : null}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
      {clients.length >= LIMIT ? (
        <p className="text-center text-sm text-stone-500">
          Showing the first {LIMIT}. Search to narrow it down.
        </p>
      ) : null}
    </div>
  );
}
