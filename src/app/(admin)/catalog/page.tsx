import { PageBoundary } from "@/components/admin/shell/page-boundary";
import type { Metadata } from "next";
import Link from "next/link";
import { Plus, Scissors } from "lucide-react";
import { getDb } from "@/db/client";
import { Badge } from "@/components/ui/badge";
import { ButtonLink } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { listLocations, listServices } from "@/server/admin-foundation/catalog";
import { formatCents } from "@/server/admin-foundation/money";
import { requireAccess } from "@/server/auth/access";
import { CatalogNav } from "./_components/catalog-nav";

export const metadata: Metadata = { title: "Catalog" };

export default function CatalogPage() {
  return (
    <PageBoundary>
      <CatalogBody />
    </PageBoundary>
  );
}

async function CatalogBody() {
  await requireAccess("catalog.edit");
  const db = getDb();
  const [services, locations] = await Promise.all([listServices(db), listLocations(db)]);
  const locationName = new Map(locations.map((l) => [l.id, l.name]));

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        eyebrow="Catalog"
        title="Services"
        description="What clients can book, what it costs and where it's offered."
        actions={
          <ButtonLink href="/catalog/services/new">
            <Plus aria-hidden className="size-4" />
            New service
          </ButtonLink>
        }
      />
      <CatalogNav active="services" />

      {services.length === 0 ? (
        <EmptyState
          icon={<Scissors className="size-8" />}
          title="No services yet"
          description="Add the cuts and treatments you offer. Clients pick from these when they book."
          action={<ButtonLink href="/catalog/services/new">Add your first service</ButtonLink>}
        />
      ) : (
        <ul className="divide-y divide-line overflow-hidden rounded-card border border-line bg-surface">
          {services.map((service) => (
            <li key={service.id}>
              <Link
                href={`/catalog/services/${service.id}`}
                className="flex min-h-16 items-center justify-between gap-4 px-4 py-3 hover:bg-paper"
              >
                <span className="min-w-0">
                  <span className="block truncate font-semibold">{service.name}</span>
                  <span className="mt-0.5 block text-sm text-ink-muted">
                    {service.durationMin} min
                    {service.bufferMin > 0 ? ` + ${service.bufferMin} buffer` : ""}
                    {" · "}
                    {service.locationIds.length === 0
                      ? "Not offered anywhere"
                      : service.locationIds.map((id) => locationName.get(id) ?? "?").join(", ")}
                  </span>
                </span>
                <span className="flex shrink-0 flex-col items-end gap-1">
                  <span className="tabular font-semibold">{formatCents(service.priceCents)}</span>
                  <span className="flex gap-1">
                    {!service.active ? <Badge>Inactive</Badge> : null}
                    {service.vipOnly ? <Badge tone="peach">VIP</Badge> : null}
                  </span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
