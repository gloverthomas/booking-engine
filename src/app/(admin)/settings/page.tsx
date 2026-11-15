import { PageBoundary } from "@/components/admin/shell/page-boundary";
import type { Metadata } from "next";
import { getDb } from "@/db/client";
import { Alert } from "@/components/ui";
import { PageHeader } from "@/components/ui/page-header";
import { parseIntegrationBanner } from "@/server/admin-foundation/integration-banner";
import { getAdminSettings } from "@/server/admin-foundation/settings-admin";
import { requireAccess } from "@/server/auth/access";
import { SettingsForm } from "./_components/settings-form";

export const metadata: Metadata = { title: "Settings" };

interface SettingsPageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default function SettingsPage({ searchParams }: SettingsPageProps) {
  return (
    <PageBoundary>
      <SettingsBody searchParams={searchParams} />
    </PageBoundary>
  );
}

async function SettingsBody({ searchParams }: SettingsPageProps) {
  await requireAccess("settings.edit");
  const banner = parseIntegrationBanner(await searchParams);
  const { settings } = await getAdminSettings(getDb());
  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        eyebrow="Settings"
        title="Business rules"
        description="Deposits, cancellation rules and how the booking page behaves."
      />
      {banner ? <Alert tone={banner.tone}>{banner.text}</Alert> : null}
      <SettingsForm initial={settings} />
    </div>
  );
}
