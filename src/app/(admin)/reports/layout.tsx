import { Suspense, type ReactNode } from "react";
import { requireAccess } from "@/server/auth/access";
import { can } from "@/server/auth/permissions";
import { ReportNav } from "./_components/ReportNav";
import "./reports.css";

/** The tabs depend on the role (stylists get their own numbers, not the whole-business pages), so they sit behind Suspense. */
async function ScopedNav() {
  const session = await requireAccess("reports.viewOwn");
  return <ReportNav showBusinessWide={can(session.role, "reports.viewAll")} />;
}

export default function ReportsLayout({ children }: { children: ReactNode }) {
  return (
    <div className="rpt">
      <header className="rpt-head">
        <div>
          <p className="rpt-eyebrow">Business</p>
          <h1>Reports</h1>
        </div>
      </header>
      <Suspense fallback={<ReportNav />}>
        <ScopedNav />
      </Suspense>
      {/* The admin shell (workstream D) provides the page's <main>. */}
      <div id="report-main">{children}</div>
    </div>
  );
}
