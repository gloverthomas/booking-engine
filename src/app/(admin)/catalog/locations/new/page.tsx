import type { Metadata } from "next";
import { getDb } from "@/db/client";
import { PageHeader } from "@/components/ui/page-header";
import { listLocations } from "@/server/admin-foundation/catalog";
import { requireOwner } from "@/server/auth";
import { LocationForm } from "../../_components/location-form";

export const metadata: Metadata = { title: "New location" };

export default async function NewLocationPage() {
  await requireOwner();
  const existing = await listLocations(getDb());
  return (
    <div className="flex flex-col gap-6">
      <PageHeader eyebrow="Catalog" title="New location" />
      <LocationForm
        initial={{
          name: "",
          addressLine: "",
          suburb: "",
          state: "VIC",
          postcode: "",
          phone: "",
          arrivalNote: "",
          active: true,
          sortOrder: existing.length,
        }}
      />
    </div>
  );
}
