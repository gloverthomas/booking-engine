import Link from "next/link";
import { joinWaitlistHref } from "./form";

/**
 * The booking page shows this when a day has no times: a short promise and a button to the waitlist
 * form, carrying the selection along.
 */
export interface JoinWaitlistCtaProps {
  locationId: string;
  serviceIds: string[];
  /** Local date (YYYY-MM-DD) the client was looking at. */
  date?: string;
  staffId?: string;
}

export function JoinWaitlistCta({ locationId, serviceIds, date, staffId }: JoinWaitlistCtaProps) {
  return (
    <div className="rk-wl-cta">
      <p className="rk-wl-cta__text">
        Nothing that suits? Join the waitlist and we&apos;ll message you if a time opens up.
      </p>
      <Link
        className="rk-btn rk-btn--ghost"
        href={joinWaitlistHref({ locationId, serviceIds, date, staffId })}
      >
        Join the waitlist
      </Link>
    </div>
  );
}
