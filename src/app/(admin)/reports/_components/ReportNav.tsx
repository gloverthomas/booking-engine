"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { Suspense } from "react";

const TABS = [
  { href: "/reports", label: "Overview" },
  { href: "/reports/revenue", label: "Revenue" },
  { href: "/reports/bookings", label: "Bookings" },
  { href: "/reports/cancellations", label: "Cancellations" },
  { href: "/reports/clients", label: "Clients" },
  { href: "/reports/outstanding", label: "Outstanding" },
] as const;

function Tabs() {
  const pathname = usePathname();
  const search = useSearchParams().toString();
  return (
    <nav className="rpt-nav" aria-label="Report sections">
      {TABS.map((tab) => (
        <Link
          key={tab.href}
          // Keep the chosen date range while moving between reports.
          href={search && tab.href !== "/reports/outstanding" ? `${tab.href}?${search}` : tab.href}
          aria-current={pathname === tab.href ? "page" : undefined}
        >
          {tab.label}
        </Link>
      ))}
    </nav>
  );
}

export function ReportNav() {
  // useSearchParams needs a Suspense boundary under Cache Components.
  return (
    <Suspense
      fallback={
        <nav className="rpt-nav" aria-label="Report sections">
          {TABS.map((t) => (
            <Link key={t.href} href={t.href}>
              {t.label}
            </Link>
          ))}
        </nav>
      }
    >
      <Tabs />
    </Suspense>
  );
}
