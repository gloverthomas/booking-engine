import type { Metadata, Viewport } from "next";
import { Bricolage_Grotesque, DM_Mono, Instrument_Sans } from "next/font/google";
import { SiteFooter } from "@/components/SiteFooter";
import { SiteHeader } from "@/components/SiteHeader";
import { SITE, entityConfigured, readEntity } from "@/lib/entity";
import "./globals.css";

const display = Bricolage_Grotesque({
  subsets: ["latin"],
  weight: ["700", "800"],
  variable: "--font-bricolage",
  display: "swap",
});
const body = Instrument_Sans({
  subsets: ["latin"],
  variable: "--font-instrument",
  display: "swap",
});
const mono = DM_Mono({
  subsets: ["latin"],
  weight: ["400", "500"],
  variable: "--font-dm-mono",
  display: "swap",
});

const configured = entityConfigured(readEntity());

export const metadata: Metadata = {
  metadataBase: new URL(SITE.url),
  title: {
    default: "HairMate: booking software for hair salons",
    template: "%s · HairMate",
  },
  description:
    "Online booking, deposits up front, reminders that cut no-shows, a calendar that syncs with Google and invoices that land in Xero. Booking software for hair salons.",
  // Stay out of search results until the legal entity details are filled in.
  robots: configured ? { index: true, follow: true } : { index: false, follow: false },
  openGraph: {
    title: "HairMate",
    description: "Book. Remind. Get paid. Booking software for hair salons.",
    url: SITE.url,
    siteName: "HairMate",
    type: "website",
  },
};

export const viewport: Viewport = { themeColor: "#fbe6d2", width: "device-width", initialScale: 1 };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en-AU" className={`${display.variable} ${body.variable} ${mono.variable}`}>
      <body>
        <a className="skip" href="#main">
          Skip to content
        </a>
        <SiteHeader />
        <main id="main">{children}</main>
        <SiteFooter />
      </body>
    </html>
  );
}
