import { PageBoundary } from "@/components/admin/shell/page-boundary";
import type { Metadata } from "next";
import { getDb } from "@/db/client";
import { PageHeader } from "@/components/ui/page-header";
import { listLocations, listServices, listStaff } from "@/server/admin-foundation/catalog";
import { getAdminSettings } from "@/server/admin-foundation/settings-admin";
import { requireOwner } from "@/server/auth";
import { ServiceForm } from "../../_components/service-form";

export const metadata: Metadata = { title: "New service" };

export default function NewServicePage() {
  return (
    <PageBoundary>
      <NewServiceBody />
    </PageBoundary>
  );
}

async function NewServiceBody() {
  await requireOwner();
  const db = getDb();
  const [locations, staff, services, { settings }] = await Promise.all([
    listLocations(db),
    listStaff(db),
    listServices(db),
    getAdminSettings(db),
  ]);
  const categories = [...new Set(services.map((s) => s.category).filter((c): c is string => !!c))];

  return (
    <div className="flex flex-col gap-6">
      <PageHeader eyebrow="Catalog" title="New service" />
      <ServiceForm
        initial={{
          name: "",
          description: "",
          category: "",
          durationMin: 30,
          priceCents: 0,
          bufferMin: 0,
          depositPct: null,
          vipOnly: false,
          active: true,
          sortOrder: services.length,
          intakeQuestions: [],
          locationIds: locations.filter((l) => l.active).map((l) => l.id),
          staff: [],
        }}
        locations={locations.map((l) => ({ id: l.id, name: l.name, active: l.active }))}
        staff={staff.filter((s) => s.active).map((s) => ({ id: s.id, name: s.name }))}
        defaultDepositPct={settings.depositPct}
        categories={categories}
      />
    </div>
  );
}
