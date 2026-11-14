import type { ReactNode } from "react";
import { formatAud, formatDuration } from "@/lib/public-api-money";
import { formatInstant } from "@/lib/public-api-time";

export interface TicketItem {
  id: string;
  name: string;
  priceCents: number;
}

interface TicketProps {
  items: readonly TicketItem[];
  locationName: string | null;
  whenIso: string | null;
  timezone: string;
  totalCents: number;
  durationMin: number;
  depositCents: number;
  /** The primary action for the current step. */
  action: ReactNode;
}

/**
 * The running total. On small screens it is a sticky bar holding just the total and the next
 * action; from 62rem it becomes the ink-black ticket beside the step.
 */
export function Ticket({
  items,
  locationName,
  whenIso,
  timezone,
  totalCents,
  durationMin,
  depositCents,
  action,
}: TicketProps) {
  const hasItems = items.length > 0;
  return (
    <aside className="rk-ticket" aria-label="Your booking">
      <p className="rk-ticket__eyebrow rk-eyebrow">Your booking</p>
      <div className="rk-ticket__body">
        {locationName || whenIso ? (
          <div className="rk-ticket__meta">
            {locationName ? <strong>{locationName}</strong> : null}
            {whenIso ? <span>{formatInstant(whenIso, timezone)}</span> : null}
          </div>
        ) : null}
        {hasItems ? (
          <ul className="rk-ticket__items">
            {items.map((item) => (
              <li key={item.id} className="rk-ticket__item">
                <span className="rk-ticket__item-name">{item.name}</span>
                <span className="rk-mono">{formatAud(item.priceCents)}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="rk-ticket__empty">Nothing selected yet.</p>
        )}
      </div>
      <div className="rk-ticket__rule" aria-hidden="true" />
      <div className="rk-ticket__foot">
        <div className="rk-ticket__sum" aria-live="polite" aria-atomic="true">
          <span className="rk-ticket__sum-label">
            Total{hasItems ? ` · ${formatDuration(durationMin)}` : ""}
          </span>
          <span className="rk-ticket__total">{formatAud(totalCents)}</span>
          {depositCents > 0 ? (
            <span className="rk-ticket__deposit">{formatAud(depositCents)} deposit</span>
          ) : null}
        </div>
        <div className="rk-ticket__cta">{action}</div>
      </div>
    </aside>
  );
}
