import type { Metadata } from "next";
import { ImportWizard } from "@/components/admin/import/ImportWizard";
import { PageBoundary } from "@/components/admin/shell/page-boundary";
import { PageHeader } from "@/components/ui/page-header";
import { getDb } from "@/db/client";
import { location, staff } from "@/db/schema";
import { requireAccess } from "@/server/auth/access";

export const metadata: Metadata = { title: "Import" };

export default function ImportPage() {
  return (
    <PageBoundary>
      <ImportBody />
    </PageBoundary>
  );
}

async function ImportBody() {
  await requireAccess("data.import");
  const db = getDb();
  const [people, places] = await Promise.all([
    db.select({ id: staff.id, name: staff.name }).from(staff),
    db.select({ id: location.id, name: location.name }).from(location),
  ]);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        eyebrow="Move over"
        title="Import from Timely"
        description="Bring across your clients and upcoming appointments. Nothing is saved until you check the result and confirm, and running the same file twice never duplicates anything."
      />
      <ImportWizard staff={people} locations={places} />
    </div>
  );
}
