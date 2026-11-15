import { PageBoundary } from "@/components/admin/shell/page-boundary";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { z } from "zod";
import { getDb } from "@/db/client";
import { PageHeader } from "@/components/ui/page-header";
import { getLocation } from "@/server/admin-foundation/catalog";
import { requireAccess } from "@/server/auth/access";
import { LocationForm } from "../../_components/location-form";

export const metadata: Metadata = { title: "Edit location" };

export default function EditLocationPage({ params }: { params: Promise<{ id: string }> }) {
  return (
    <PageBoundary>
      <EditLocationBody params={params} />
    </PageBoundary>
  );
}

async function EditLocationBody({ params }: { params: Promise<{ id: string }> }) {
  await requireAccess("catalog.edit");
  const { id } = await params;
  if (!z.uuid().safeParse(id).success) notFound();
  const location = await getLocation(getDb(), id);
  if (!location) notFound();

  return (
    <div className="flex flex-col gap-6">
      <PageHeader eyebrow="Catalog" title={location.name} />
      <LocationForm
        initial={{
          id: location.id,
          name: location.name,
          addressLine: location.addressLine ?? "",
          suburb: location.suburb ?? "",
          state: location.state ?? "",
          postcode: location.postcode ?? "",
          phone: location.phone ?? "",
          arrivalNote: location.arrivalNote ?? "",
          active: location.active,
          sortOrder: location.sortOrder,
        }}
      />
    </div>
  );
}
