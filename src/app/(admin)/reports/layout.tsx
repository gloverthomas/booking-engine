import type { ReactNode } from "react";
import { ReportNav } from "./_components/ReportNav";
import "./reports.css";

export default function ReportsLayout({ children }: { children: ReactNode }) {
  return (
    <div className="rpt">
      <header className="rpt-head">
        <div>
          <p className="rpt-eyebrow">Business</p>
          <h1>Reports</h1>
        </div>
      </header>
      <ReportNav />
      {/* The admin shell (workstream D) provides the page's <main>. */}
      <div id="report-main">{children}</div>
    </div>
  );
}
