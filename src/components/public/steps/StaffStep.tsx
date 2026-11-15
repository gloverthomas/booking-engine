import { formatAud, formatDuration } from "@/lib/public-api-money";
import { initialsOf, type StaffOption } from "@/lib/public-api-staff";
import { Check } from "../ui/icons";

interface StaffStepProps {
  options: readonly StaffOption[];
  /** The chosen stylist, or null for "Anyone available". */
  selectedId: string | null;
  onSelect: (id: string | null) => void;
}

/**
 * "Anyone available" (the default) or one of the stylists who can do every chosen service. Prices
 * and times appear only when they differ between stylists, so a single-price salon sees a plain list.
 */
export function StaffStep({ options, selectedId, onSelect }: StaffStepProps) {
  const onlyAnyone = options.length <= 1;
  return (
    <fieldset className="rk-fieldset">
      <legend className="rk-sr-only">Choose a stylist</legend>
      {onlyAnyone ? (
        <p className="rk-staff-note" role="status">
          No single stylist does all of those services, so we&apos;ll match you with whoever is
          free. Go back to change your services if you&apos;d like to pick a stylist.
        </p>
      ) : null}
      <div className="rk-options">
        {options.map((option, i) => (
          <label
            key={option.id ?? "anyone"}
            className="rk-option rk-option--radio rk-rise"
            style={{ "--i": i } as React.CSSProperties}
          >
            <input
              className="rk-option__input"
              type="radio"
              name="stylist"
              value={option.id ?? ""}
              checked={selectedId === option.id}
              onChange={() => onSelect(option.id)}
            />
            <span className="rk-option__body">
              <span className="rk-option__mark">
                <Check size={16} />
              </span>
              <span className="rk-staff-who">
                <span className="rk-staff-avatar" aria-hidden="true">
                  {option.id === null ? "★" : initialsOf(option.name)}
                </span>
                <span>
                  <span className="rk-option__name">{option.name}</span>
                  {option.id === null ? (
                    <span className="rk-option__desc">First available stylist for your time</span>
                  ) : null}
                </span>
              </span>
              <span className="rk-option__facts">
                {option.showPrice ? (
                  <>
                    <span className="rk-option__price">
                      {option.fromPrefix ? "from " : ""}
                      {formatAud(option.quote.totalCents)}
                    </span>
                    {option.fromPrefix ? null : formatDuration(option.quote.durationMin)}
                  </>
                ) : null}
              </span>
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}
