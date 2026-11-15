import type { Metadata } from "next";
import { PageBoundary } from "@/components/admin/shell/page-boundary";
import { StaffManager } from "@/components/admin/staff/StaffManager";
import { toStaffRowViews } from "@/components/admin/staff/views";
import { PageHeader } from "@/components/ui/page-header";
import { getDb } from "@/db/client";
import { getEnv } from "@/lib/env";
import { getBusiness } from "@/server/admin-foundation/business";
import { requireAccess } from "@/server/auth/access";
import { listStaff } from "@/server/staff/queries";

export const metadata: Metadata = { title: "Staff" };

export default function StaffPage() {
  return (
    <PageBoundary>
      <StaffBody />
    </PageBoundary>
  );
}

async function StaffBody() {
  const session = await requireAccess("staff.manage");
  const db = getDb();
  const env = getEnv();
  const [biz, people] = await Promise.all([getBusiness(db), listStaff(db)]);

  const views = toStaffRowViews(people, biz.timezone);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        eyebrow="Team"
        title="Staff"
        description="Who works here, what they can see and do, and whose Google Calendar is linked."
      />
      <StaffManager
        people={views}
        viewerRole={session.role}
        googleConfigured={Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET)}
      />
    </div>
  );
}
