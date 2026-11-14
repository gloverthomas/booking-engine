import { Archivo } from "next/font/google";

/**
 * Display face: Archivo at heavy weights, set uppercase and tight (see `.display` in globals.css).
 * Text face is Geist, loaded by the root layout. Admin layouts put `archivo.variable` on their wrapper.
 */
export const archivo = Archivo({
  subsets: ["latin"],
  weight: "variable",
  variable: "--font-archivo",
  display: "swap",
});
