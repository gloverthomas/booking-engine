import type { Metadata } from "next";
import { getDb } from "@/db/client";
import { PageHeader } from "@/components/ui/page-header";
import { getAdminSettings } from "@/server/admin-foundation/settings-admin";
import { requireOwner } from "@/server/auth";
import { SettingsForm } from "./_components/settings-form";

export const metadata: Metadata = { title: "Settings" };

export default async function SettingsPage() {
  await requireOwner();
  const { settings } = await getAdminSettings(getDb());
  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        eyebrow="Settings"
        title="Business rules"
        description="Deposits, cancellation rules and how the booking page behaves."
      />
      <SettingsForm initial={settings} />
    </div>
  );
}
