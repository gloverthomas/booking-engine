import type { CatalogLocation } from "@/lib/public-api-types";
import { Check } from "../ui/icons";
import { LocationMap } from "../ui/LocationMap";

interface LocationStepProps {
  locations: readonly CatalogLocation[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}

function addressOf(location: CatalogLocation): string {
  const locality = [location.suburb, location.state, location.postcode].filter(Boolean).join(" ");
  return [location.addressLine, locality].filter(Boolean).join(", ");
}

export function LocationStep({ locations, selectedId, onSelect }: LocationStepProps) {
  const selected = locations.find((l) => l.id === selectedId) ?? null;
  return (
    <>
      <fieldset className="rk-fieldset">
        <legend className="rk-sr-only">Choose a location</legend>
        <div className="rk-options">
          {locations.map((location, i) => (
            <label
              key={location.id}
              className="rk-option rk-option--radio rk-rise"
              style={{ "--i": i } as React.CSSProperties}
            >
              <input
                className="rk-option__input"
                type="radio"
                name="location"
                value={location.id}
                checked={selectedId === location.id}
                onChange={() => onSelect(location.id)}
              />
              <span className="rk-option__body">
                <span className="rk-option__mark">
                  <Check size={16} />
                </span>
                <span>
                  <span className="rk-option__name">{location.name}</span>
                  <span className="rk-option__desc">{addressOf(location)}</span>
                </span>
                <span className="rk-option__facts">
                  {location.services.length} service{location.services.length === 1 ? "" : "s"}
                </span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>
      {selected ? <LocationMap location={selected} /> : null}
    </>
  );
}
