import type { ReactNode } from "react";
import { ToastProvider } from "@/components/ui/toast";
import { SidebarNav, BottomNav } from "./admin-nav";
import { RegisterServiceWorker } from "./register-service-worker";
import { SignOutButton } from "./sign-out-button";

export interface AdminShellProps {
  user: { email: string };
  children: ReactNode;
}

/**
 * The signed-in frame: sidebar on desktop, bottom tab bar on phones.
 * `--bottom-nav-h` is the tab bar height; the toast region and page padding use it.
 */
export function AdminShell({ user, children }: AdminShellProps) {
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
            <SidebarNav />
          </div>
          <div className="border-t border-line px-3 py-3">
            <p className="truncate px-3 pb-2 text-xs text-ink-subtle" title={user.email}>
              {user.email}
            </p>
            <SignOutButton />
          </div>
        </aside>

        <header className="sticky top-0 z-20 flex h-12 items-center justify-between border-b border-ink bg-paper px-4 lg:hidden">
          <p className="display text-lg">Ryan Kennedy</p>
          <p className="eyebrow">Admin</p>
        </header>

        <main
          id="main"
          className="px-[var(--space-page)] pb-[calc(var(--bottom-nav-h)+env(safe-area-inset-bottom)+2rem)] pt-6 lg:ml-64 lg:pb-16 lg:pt-10"
        >
          <div className="mx-auto w-full max-w-5xl">{children}</div>
        </main>

        <BottomNav footer={<SignOutButton />} />
        <RegisterServiceWorker />
      </div>
    </ToastProvider>
  );
}
