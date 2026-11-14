import type { Metadata } from "next";
import Link from "next/link";
import { MapPin, Plus } from "lucide-react";
import { getDb } from "@/db/client";
import { Badge } from "@/components/ui/badge";
import { ButtonLink } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { listLocations } from "@/server/admin-foundation/catalog";
import { requireOwner } from "@/server/auth";
import { CatalogNav } from "../_components/catalog-nav";

export const metadata: Metadata = { title: "Locations" };

export default async function LocationsPage() {
  await requireOwner();
  const locations = await listLocations(getDb());

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        eyebrow="Catalog"
        title="Locations"
        description="Where you work. Each location has its own weekly hours."
        actions={
          <ButtonLink href="/catalog/locations/new">
            <Plus aria-hidden className="size-4" />
            New location
          </ButtonLink>
        }
      />
      <CatalogNav active="locations" />

      {locations.length === 0 ? (
        <EmptyState
          icon={<MapPin className="size-8" />}
          title="No locations yet"
          description="Add the places clients can book at."
          action={<ButtonLink href="/catalog/locations/new">Add a location</ButtonLink>}
        />
      ) : (
        <ul className="divide-y divide-line overflow-hidden rounded-card border border-line bg-surface">
          {locations.map((location) => (
            <li key={location.id}>
              <Link
                href={`/catalog/locations/${location.id}`}
                className="flex min-h-16 items-center justify-between gap-4 px-4 py-3 hover:bg-paper"
              >
                <span className="min-w-0">
                  <span className="block truncate font-semibold">{location.name}</span>
                  <span className="mt-0.5 block truncate text-sm text-ink-muted">
                    {[location.addressLine, location.suburb, location.state, location.postcode]
                      .filter(Boolean)
                      .join(", ") || "No address yet"}
                  </span>
                </span>
                {!location.active ? <Badge>Inactive</Badge> : null}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
