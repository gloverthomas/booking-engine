import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { z } from "zod";
import { getDb } from "@/db/client";
import { PageHeader } from "@/components/ui/page-header";
import { listLocations, listServices, listStaff } from "@/server/admin-foundation/catalog";
import { getAdminSettings } from "@/server/admin-foundation/settings-admin";
import { requireOwner } from "@/server/auth";
import { ServiceForm } from "../../_components/service-form";

export const metadata: Metadata = { title: "Edit service" };

export default async function EditServicePage({ params }: { params: Promise<{ id: string }> }) {
  await requireOwner();
  const { id } = await params;
  if (!z.uuid().safeParse(id).success) notFound();

  const db = getDb();
  const [services, locations, staff, { settings }] = await Promise.all([
    listServices(db),
    listLocations(db),
    listStaff(db),
    getAdminSettings(db),
  ]);
  const service = services.find((s) => s.id === id);
  if (!service) notFound();
  const categories = [...new Set(services.map((s) => s.category).filter((c): c is string => !!c))];

  return (
    <div className="flex flex-col gap-6">
      <PageHeader eyebrow="Catalog" title={service.name} />
      <ServiceForm
        initial={{
          id: service.id,
          name: service.name,
          description: service.description ?? "",
          category: service.category ?? "",
          durationMin: service.durationMin,
          priceCents: service.priceCents,
          bufferMin: service.bufferMin,
          depositPct: service.depositPct,
          vipOnly: service.vipOnly,
          active: service.active,
          sortOrder: service.sortOrder,
          intakeQuestions: service.intakeQuestions,
          locationIds: service.locationIds,
          staff: service.staff,
        }}
        locations={locations.map((l) => ({ id: l.id, name: l.name, active: l.active }))}
        staff={staff
          .filter((s) => s.active || service.staff.some((o) => o.staffId === s.id))
          .map((s) => ({ id: s.id, name: s.name }))}
        defaultDepositPct={settings.depositPct}
        categories={categories}
      />
    </div>
  );
}
