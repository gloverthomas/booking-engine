import type { Metadata, Viewport } from "next";
import { Suspense, type ReactNode } from "react";
import { AdminShell } from "@/components/admin/shell/admin-shell";
import { archivo } from "@/components/admin/shell/fonts";
import { requireOwner } from "@/server/auth";

export const metadata: Metadata = {
  title: { default: "Admin", template: "%s · Ryan Kennedy Admin" },
  description: "Ryan Kennedy Hairdressing admin",
  robots: { index: false, follow: false },
  appleWebApp: { capable: true, title: "RK Admin", statusBarStyle: "default" },
  formatDetection: { telephone: false },
  icons: { apple: "/icons/apple-touch-icon.png" },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#fff8f1" },
    { media: "(prefers-color-scheme: dark)", color: "#12100e" },
  ],
};

/**
 * Every route under (admin) is behind requireOwner(). The session is read at request time, so it
 * sits behind a Suspense boundary (Cache Components): the fallback is the only thing prerendered.
 * Pages and server actions also call requireOwner() themselves, because layouts are not re-run on
 * every client navigation and must never be the only gate.
 * The login page lives in the sibling (auth) group so it is not behind this guard.
 */
export default function AdminLayout({ children }: { children: ReactNode }) {
  return (
    <div className={archivo.variable}>
      <Suspense fallback={<ShellFallback />}>
        <SignedInShell>{children}</SignedInShell>
      </Suspense>
    </div>
  );
}

async function SignedInShell({ children }: { children: ReactNode }) {
  const owner = await requireOwner();
  return <AdminShell user={{ email: owner.email }}>{children}</AdminShell>;
}

function ShellFallback() {
  return (
    <div aria-busy="true" className="min-h-dvh bg-paper">
      <p className="sr-only" role="status">
        Loading
      </p>
    </div>
  );
}
