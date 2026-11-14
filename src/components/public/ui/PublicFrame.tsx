"use client";

import Link from "next/link";
import { useRef, type ReactNode } from "react";
import { useEmbedResize, useEmbedded } from "../flow/use-embed";

export const BRAND_NAME = "Ryan Kennedy";

interface PublicFrameProps {
  /** Small right-hand note in the top bar, e.g. the time zone. */
  note?: string;
  children: (ctx: {
    embedded: boolean;
    rootRef: React.RefObject<HTMLDivElement | null>;
  }) => ReactNode;
}

/**
 * Page chrome shared by every public page: top bar, footer, and the iframe plumbing (compact
 * layout plus height reporting to the host page).
 */
export function PublicFrame({ note = "Melbourne", children }: PublicFrameProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const embedded = useEmbedded();
  useEmbedResize(rootRef, embedded);

  return (
    <div ref={rootRef} className={`rk-page${embedded ? " rk-embedded" : ""}`}>
      <header className="rk-topbar">
        <Link className="rk-wordmark" href="/book">
          {BRAND_NAME}
          <span>Hairdressing</span>
        </Link>
        <p className="rk-topbar__note rk-eyebrow">{note}</p>
      </header>
      <main>{children({ embedded, rootRef })}</main>
      <footer className="rk-footer">
        <p>Bookings are held for a few minutes while you pay your deposit.</p>
      </footer>
    </div>
  );
}
