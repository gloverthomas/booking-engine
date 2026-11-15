"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState, type ReactNode } from "react";
import { Ellipsis } from "lucide-react";
import { cn } from "@/components/ui/cn";
import { Sheet } from "@/components/ui/dialog";
import { isActivePath, splitNav, type NavItem } from "./nav-config";
import { NavGlyph } from "./nav-icon";

/** Desktop sidebar list. */
export function SidebarNav({ items }: { items: readonly NavItem[] }) {
  const pathname = usePathname();
  return (
    <nav aria-label="Main">
      <ul className="flex flex-col gap-0.5">
        {items.map((item) => {
          const active = isActivePath(pathname, item.href);
          return (
            <li key={item.href}>
              <Link
                href={item.href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "flex min-h-11 items-center gap-3 rounded-control px-3 text-[0.9375rem] font-semibold",
                  "transition-colors duration-[var(--duration-fast)]",
                  active ? "bg-ink text-paper" : "text-ink-muted hover:bg-peach hover:text-ink",
                )}
              >
                <NavGlyph icon={item.icon} className="size-5" />
                {item.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

const tabBase =
  "relative flex min-h-14 flex-1 flex-col items-center justify-center gap-0.5 px-1 text-[0.6875rem] font-semibold";

/** Phone tab bar: four main destinations plus a "More" sheet for the rest. */
export function BottomNav({ items, footer }: { items: readonly NavItem[]; footer: ReactNode }) {
  const pathname = usePathname();
  const [moreOpen, setMoreOpen] = useState(false);
  const { primary, more } = splitNav(items);
  const moreActive = more.some((item) => isActivePath(pathname, item.href));

  return (
    <>
      <nav
        aria-label="Main"
        className="fixed inset-x-0 bottom-0 z-30 border-t border-ink bg-paper pb-[env(safe-area-inset-bottom)] lg:hidden"
      >
        <ul className="flex h-[var(--bottom-nav-h)] items-stretch">
          {primary.map((item) => {
            const active = isActivePath(pathname, item.href);
            return (
              <li key={item.href} className="flex flex-1">
                <Link
                  href={item.href}
                  aria-current={active ? "page" : undefined}
                  className={cn(tabBase, active ? "text-ink" : "text-ink-subtle")}
                >
                  {active ? (
                    <span aria-hidden className="absolute inset-x-3 top-0 h-[3px] bg-ink" />
                  ) : null}
                  <NavGlyph icon={item.icon} className="size-6" strokeWidth={active ? 2.5 : 2} />
                  {item.label}
                </Link>
              </li>
            );
          })}
          <li className="flex flex-1">
            <button
              type="button"
              onClick={() => setMoreOpen(true)}
              aria-haspopup="dialog"
              aria-expanded={moreOpen}
              className={cn(tabBase, moreActive ? "text-ink" : "text-ink-subtle")}
            >
              {moreActive ? (
                <span aria-hidden className="absolute inset-x-3 top-0 h-[3px] bg-ink" />
              ) : null}
              <Ellipsis aria-hidden className="size-6" />
              More
            </button>
          </li>
        </ul>
      </nav>

      <Sheet open={moreOpen} onClose={() => setMoreOpen(false)} title="More">
        <nav aria-label="More">
          <ul className="flex flex-col">
            {more.map((item) => {
              const active = isActivePath(pathname, item.href);
              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    onClick={() => setMoreOpen(false)}
                    aria-current={active ? "page" : undefined}
                    className={cn(
                      "flex min-h-14 items-center gap-3 border-b border-line text-base font-semibold",
                      active ? "text-ink" : "text-ink-muted",
                    )}
                  >
                    <NavGlyph icon={item.icon} className="size-5" />
                    {item.label}
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>
        <div className="mt-3">{footer}</div>
      </Sheet>
    </>
  );
}
