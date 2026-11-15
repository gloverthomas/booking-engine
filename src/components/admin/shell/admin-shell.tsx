import type { ReactNode } from "react";
import { ClockWidget } from "@/components/admin/clock/ClockWidget";
import { ToastProvider } from "@/components/ui/toast";
import type { StaffRole } from "@/server/contracts";
import { ROLE_LABELS } from "@/server/staff/schemas";
import { SidebarNav, BottomNav } from "./admin-nav";
import type { NavItem } from "./nav-config";
import { RegisterServiceWorker } from "./register-service-worker";
import { SignOutButton } from "./sign-out-button";

export interface AdminShellProps {
  user: { email: string; name?: string; role: StaffRole };
  /** Already filtered for the signed-in role (see navFor). */
  items: readonly NavItem[];
  /** Mount the clock in / out control (roles with timesheets.clock). */
  showClock: boolean;
  children: ReactNode;
}

function WhoAmI({ user }: { user: AdminShellProps["user"] }) {
  return (
    <div className="px-3 pb-2" aria-label="Signed in as">
      <p className="truncate text-sm font-semibold">{user.name ?? user.email}</p>
      <p className="truncate text-xs text-ink-subtle" title={user.email}>
        {ROLE_LABELS[user.role]} · {user.email}
      </p>
    </div>
  );
}

/**
 * The signed-in frame: sidebar on desktop, bottom tab bar on phones.
 * `--bottom-nav-h` is the tab bar height; the toast region and page padding use it.
 */
export function AdminShell({ user, items, showClock, children }: AdminShellProps) {
  return (
    <ToastProvider>
      <div className="min-h-dvh [--bottom-nav-h:4rem] lg:[--bottom-nav-h:0px]">
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-50 focus:rounded-control focus:bg-ink focus:px-4 focus:py-3 focus:text-paper"
        >
          Skip to content
        </a>

        <aside className="fixed inset-y-0 left-0 z-20 hidden w-64 flex-col border-r border-ink bg-paper lg:flex">
          <div className="border-b border-ink px-5 py-5">
            <p className="eyebrow">Hairdressing admin</p>
            <p className="display mt-2 text-[1.75rem]">Ryan Kennedy</p>
          </div>
          <div className="flex-1 overflow-y-auto px-3 py-4">
            <SidebarNav items={items} />
          </div>
          <div className="border-t border-line px-3 py-3">
            <WhoAmI user={user} />
            <SignOutButton />
          </div>
        </aside>

        <header className="sticky top-0 z-20 flex h-12 items-center justify-between border-b border-ink bg-paper px-4 lg:hidden">
          <p className="display text-lg">Ryan Kennedy</p>
          <p className="eyebrow">{ROLE_LABELS[user.role]}</p>
        </header>

        <main
          id="main"
          className="px-[var(--space-page)] pb-[calc(var(--bottom-nav-h)+env(safe-area-inset-bottom)+2rem)] pt-6 lg:ml-64 lg:pb-16 lg:pt-10"
        >
          <div className="mx-auto w-full max-w-5xl">
            {showClock ? (
              <div className="mb-4 flex justify-end empty:hidden">
                <ClockWidget />
              </div>
            ) : null}
            {children}
          </div>
        </main>

        <BottomNav
          items={items}
          footer={
            <>
              <WhoAmI user={user} />
              <SignOutButton />
            </>
          }
        />
        <RegisterServiceWorker />
      </div>
    </ToastProvider>
  );
}
