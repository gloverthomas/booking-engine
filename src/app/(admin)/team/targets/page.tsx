import Link from "next/link";
import { connection } from "next/server";
import { Suspense } from "react";
import { asc } from "drizzle-orm";
import { DateTime } from "luxon";
import { getDb } from "@/db/client";
import { staff } from "@/db/schema";
import { PageHeader } from "@/components/ui";
import { requireAccess } from "@/server/auth/access";
import { loadBusinessContext } from "@/server/reports/context";
import { listTargets } from "@/server/targets/crud";
import { formatTargetValue, targetInputValue } from "@/server/targets/units";
import { TargetsManager, type TargetView } from "../_components/TargetsManager";

export const metadata = { title: "Targets" };

export default function TargetsPage() {
  return (
    <Suspense
      fallback={
        <p role="status" className="py-10 text-ink-muted">
          Loading targets
        </p>
      }
    >
      <Loaded />
    </Suspense>
  );
}

async function Loaded() {
  await connection();
  await requireAccess("staff.manage");
  const db = getDb();
  const { timezone } = await loadBusinessContext(db);
  const [rows, people] = await Promise.all([
    listTargets(db),
    db.select({ id: staff.id, name: staff.name }).from(staff).orderBy(asc(staff.name)),
  ]);
  const targets: TargetView[] = rows.map((t) => ({
    id: t.id,
    staffId: t.staffId,
    staffName: t.staffName,
    metric: t.metric,
    period: t.period,
    valueText: formatTargetValue(t.metric, t.targetValue),
    inputValue: targetInputValue(t.metric, t.targetValue),
    validFrom: t.validFrom,
    validTo: t.validTo,
  }));
  const today = DateTime.now().setZone(timezone).toISODate() ?? "";
  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        eyebrow="Team"
        title="Targets"
        description="Goals for each stylist or for the whole business. Stylists see only their own on the performance page."
        actions={
          <Link className="underline" href="/team">
            Back to performance
          </Link>
        }
      />
      <TargetsManager targets={targets} staff={people} today={today} />
    </div>
  );
}
