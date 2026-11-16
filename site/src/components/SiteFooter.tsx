import Link from "next/link";
import { SITE, readEntity } from "@/lib/entity";

export function SiteFooter() {
  const entity = readEntity();
  return (
    <footer className="footer">
      <div className="wrap">
        <div className="footer__grid">
          <div>
            <p className="wordmark" style={{ fontSize: "2.4rem", margin: "0 0 1rem" }}>
              Hair<span>Mate</span>
            </p>
            <p style={{ maxWidth: "26rem", margin: 0 }}>
              Booking software for hair salons. Book, remind, get paid.
            </p>
          </div>
          <div>
            <h2>Site</h2>
            <ul>
              <li>
                <Link href="/#features">Features</Link>
              </li>
              <li>
                <Link href="/#how">How it works</Link>
              </li>
              <li>
                <Link href="/contact">Contact</Link>
              </li>
              <li>
                <a href={`${SITE.appUrl}/login`} rel="nofollow">
                  Sign in
                </a>
              </li>
            </ul>
          </div>
          <div>
            <h2>Legal</h2>
            <ul>
              <li>
                <Link href="/privacy">Privacy policy</Link>
              </li>
              <li>
                <Link href="/terms">Terms of use</Link>
              </li>
              <li>
                <Link href="/messaging">Messaging policy</Link>
              </li>
              <li>
                <Link href="/security">Security</Link>
              </li>
            </ul>
          </div>
        </div>
        <p className="footer__fine">
          HairMate is operated by {entity.legalName} (ABN {entity.abn}), trading as{" "}
          {entity.tradingName}. {entity.address !== "to be confirmed" ? entity.address : ""}
        </p>
      </div>
    </footer>
  );
}
