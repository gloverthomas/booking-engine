import Link from "next/link";
import { SITE } from "@/lib/entity";

export function SiteHeader() {
  return (
    <header className="header">
      <div className="wrap header__row">
        <Link href="/" className="wordmark" aria-label="HairMate home">
          Hair<span>Mate</span>
        </Link>
        <nav className="nav" aria-label="Main">
          <Link href="/#features" className="nav__hide">
            Features
          </Link>
          <Link href="/#how" className="nav__hide">
            How it works
          </Link>
          <Link href="/#claude" className="nav__hide">
            Ask Claude
          </Link>
          <a href={`${SITE.appUrl}/login`} className="nav__hide" rel="nofollow">
            Staff sign in
          </a>
          <Link href="/contact" className="btn btn--ink">
            Contact
          </Link>
        </nav>
      </div>
    </header>
  );
}
