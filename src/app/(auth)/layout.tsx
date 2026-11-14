import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { archivo } from "@/components/admin/shell/fonts";

export const metadata: Metadata = {
  title: "Sign in · Ryan Kennedy Admin",
  robots: { index: false, follow: false },
  icons: { apple: "/icons/apple-touch-icon.png" },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#fde9d6" },
    { media: "(prefers-color-scheme: dark)", color: "#12100e" },
  ],
};

/** Unguarded frame for the sign-in page (it must be reachable while signed out). */
export default function AuthLayout({ children }: { children: ReactNode }) {
  return <div className={archivo.variable}>{children}</div>;
}
