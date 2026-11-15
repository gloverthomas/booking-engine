"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { Suspense } from "react";

interface Tab {
  href: string;
  label: string;
  /** Whole-business pages: only for roles with reports.viewAll. */
  businessWide?: boolean;
}

const TABS: readonly Tab[] = [
  { href: "/reports", label: "Overview" },
  { href: "/reports/revenue", label: "Revenue" },
  { href: "/reports/bookings", label: "Bookings" },
  { href: "/reports/cancellations", label: "Cancellations" },
  { href: "/reports/clients", label: "Clients", businessWide: true },
  { href: "/reports/outstanding", label: "Outstanding", businessWide: true },
];

const visible = (showBusinessWide: boolean) =>
  TABS.filter((t) => showBusinessWide || !t.businessWide);

function Tabs({ showBusinessWide }: { showBusinessWide: boolean }) {
  const pathname = usePathname();
  const search = useSearchParams().toString();
  return (
    <nav className="rpt-nav" aria-label="Report sections">
      {visible(showBusinessWide).map((tab) => (
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

export function ReportNav({ showBusinessWide = false }: { showBusinessWide?: boolean }) {
  // useSearchParams needs a Suspense boundary under Cache Components.
  return (
    <Suspense
      fallback={
        <nav className="rpt-nav" aria-label="Report sections">
          {visible(showBusinessWide).map((t) => (
            <Link key={t.href} href={t.href}>
              {t.label}
            </Link>
          ))}
        </nav>
      }
    >
      <Tabs showBusinessWide={showBusinessWide} />
    </Suspense>
  );
}
