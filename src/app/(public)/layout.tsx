import type { Metadata, Viewport } from "next";
import { Archivo, DM_Mono } from "next/font/google";
import "@/components/public/styles/tokens.css";
import "@/components/public/styles/shell.css";
import "@/components/public/styles/steps.css";
import "@/components/public/styles/calendar.css";
import "@/components/public/styles/forms.css";
import "@/components/public/styles/confirm.css";

/** Display and body: one variable grotesk, set heavy and tight for headings. */
const archivo = Archivo({
  subsets: ["latin"],
  axes: ["wdth"],
  variable: "--font-archivo",
  display: "swap",
});

/** Times, prices and small labels. */
const dmMono = DM_Mono({
  subsets: ["latin"],
  weight: ["400", "500"],
  variable: "--font-dm-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: {
    default: "Book an appointment | Ryan Kennedy Hairdressing",
    template: "%s | Ryan Kennedy Hairdressing",
  },
  description: "Book your haircut with Ryan Kennedy in Melbourne.",
};

export const viewport: Viewport = {
  themeColor: "#fde9d6",
  width: "device-width",
  initialScale: 1,
};

export default function PublicLayout({ children }: { children: React.ReactNode }) {
  return <div className={`rk-root ${archivo.variable} ${dmMono.variable}`}>{children}</div>;
}
