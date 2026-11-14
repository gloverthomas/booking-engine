import type { ReactNode } from "react";
import { LEGAL_UPDATED, entityConfigured, readEntity } from "@/lib/entity";

export function LegalPage({
  title,
  intro,
  children,
}: {
  title: string;
  intro: string;
  children: ReactNode;
}) {
  const configured = entityConfigured(readEntity());
  return (
    <article className="wrap legal">
      <p className="eyebrow">Last updated {LEGAL_UPDATED}</p>
      <h1 className="display">{title}</h1>
      <p className="lede">{intro}</p>
      {configured ? null : (
        <p className="draft" role="note">
          <strong>Draft.</strong> The details of the business operating HairMate are still being
          confirmed, so some lines below say &ldquo;to be confirmed&rdquo;.
        </p>
      )}
      {children}
    </article>
  );
}

/** "HairMate is operated by ..." sentence reused across pages. */
export function Operator() {
  const e = readEntity();
  return (
    <>
      {e.legalName} (ABN {e.abn}), trading as {e.tradingName}
    </>
  );
}
