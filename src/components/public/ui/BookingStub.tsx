import { formatAud, formatDuration } from "@/lib/public-api-money";
import { formatInstant } from "@/lib/public-api-time";
import type { ManageBookingData } from "@/lib/public-api-types";

const STATUS_LABELS: Record<string, { label: string; tone: "ok" | "warn" }> = {
  confirmed: { label: "Confirmed", tone: "ok" },
  pending_payment: { label: "Awaiting deposit", tone: "warn" },
  completed: { label: "Completed", tone: "ok" },
  cancelled_by_client: { label: "Cancelled", tone: "warn" },
  cancelled_by_staff: { label: "Cancelled", tone: "warn" },
  late_cancelled: { label: "Cancelled", tone: "warn" },
  no_show: { label: "Missed", tone: "warn" },
  expired: { label: "Expired", tone: "warn" },
};

interface BookingStubProps {
  data: ManageBookingData;
}

/** The booking as an ink-black ticket with a perforated stub for the money. */
export function BookingStub({ data }: BookingStubProps) {
  const { booking, timezone, staffName } = data;
  const status = STATUS_LABELS[booking.status] ?? { label: booking.status, tone: "warn" as const };
  const durationMin = Math.round(
    (new Date(booking.end).getTime() - new Date(booking.start).getTime()) / 60_000,
  );
  const balance = Math.max(0, booking.totalCents - booking.depositCents);

  return (
    <article className="rk-stub" aria-label="Booking summary">
      <div className="rk-stub__main">
        <div>
          <span className={`rk-badge rk-badge--${status.tone}`}>{status.label}</span>
        </div>
        <p className="rk-stub__when">{formatInstant(booking.start, timezone)}</p>
        <dl className="rk-stub__rows">
          <div className="rk-stub__row">
            <dt>Where</dt>
            <dd>{booking.locationName}</dd>
          </div>
          {staffName ? (
            <div className="rk-stub__row">
              <dt>Stylist</dt>
              <dd>{staffName}</dd>
            </div>
          ) : null}
          <div className="rk-stub__row">
            <dt>Time needed</dt>
            <dd>{formatDuration(durationMin)}</dd>
          </div>
          {booking.services.map((svc, i) => (
            <div className="rk-stub__row" key={`${svc.name}-${i}`}>
              <dt>{svc.name}</dt>
              <dd className="rk-mono">{formatAud(svc.priceCents)}</dd>
            </div>
          ))}
        </dl>
      </div>
      <div className="rk-stub__perf" aria-hidden="true" />
      <div className="rk-stub__totals">
        <div className="rk-stub__total-row">
          <span>Total</span>
          <span className="rk-stub__big">{formatAud(booking.totalCents)}</span>
        </div>
        {booking.depositCents > 0 ? (
          <>
            <div className="rk-stub__total-row">
              <span>Deposit {booking.status === "pending_payment" ? "due" : "paid"}</span>
              <span className="rk-mono">{formatAud(booking.depositCents)}</span>
            </div>
            <div className="rk-stub__total-row">
              <span>To pay on the day</span>
              <span className="rk-mono">{formatAud(balance)}</span>
            </div>
          </>
        ) : null}
      </div>
    </article>
  );
}

/** Where, how to find us, and what happens if plans change. */
export function BookingAside({ data }: BookingStubProps) {
  const { location, cancellation, timezone } = data;
  const mapsUrl = location.address
    ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(
        `${location.name} ${location.address}`,
      )}`
    : null;

  return (
    <div className="rk-aside">
      <section>
        <h2>Where</h2>
        <p>
          <strong>{location.name}</strong>
        </p>
        {location.address ? <p>{location.address}</p> : null}
        {location.arrivalNote ? <p>{location.arrivalNote}</p> : null}
        {mapsUrl ? (
          <p>
            <a href={mapsUrl} target="_blank" rel="noopener noreferrer">
              Open in Maps<span className="rk-sr-only"> (opens in a new tab)</span>
            </a>
          </p>
        ) : null}
      </section>
      <section>
        <h2>If plans change</h2>
        <p>
          Change or cancel free of charge up to {cancellation.windowHours} hours before your
          appointment
          {cancellation.canCancel
            ? ` (until ${formatInstant(cancellation.deadline, timezone)})`
            : ""}
          . After that, your deposit is not refunded.
        </p>
      </section>
    </div>
  );
}
