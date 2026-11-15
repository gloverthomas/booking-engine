import type { CatalogService, CatalogStaff } from "@/lib/public-api-types";
import { formatAud, formatDuration } from "@/lib/public-api-money";
import { serviceRange } from "@/lib/public-api-staff";
import { Check } from "../ui/icons";

interface ServicesStepProps {
  services: readonly CatalogService[];
  selectedIds: readonly string[];
  onToggle: (id: string) => void;
  /** Stylists at this location (empty unless clients may choose); used to show "from" prices. */
  staff?: readonly CatalogStaff[];
}

/** Group by category, keeping first-seen order. A single unnamed group renders without a heading. */
export function groupByCategory(
  services: readonly CatalogService[],
): Array<{ title: string | null; services: CatalogService[] }> {
  const groups = new Map<string, CatalogService[]>();
  for (const svc of services) {
    const key = svc.category?.trim() ?? "";
    groups.set(key, [...(groups.get(key) ?? []), svc]);
  }
  return [...groups.entries()].map(([title, list]) => ({ title: title || null, services: list }));
}

export function ServicesStep({ services, selectedIds, onToggle, staff = [] }: ServicesStepProps) {
  const groups = groupByCategory(services);
  let index = 0;
  return (
    <fieldset className="rk-fieldset">
      <legend className="rk-sr-only">Choose one or more services</legend>
      {groups.map((group) => (
        <div className="rk-group" key={group.title ?? "all"}>
          {group.title && groups.length > 1 ? (
            <h3 className="rk-group__title">{group.title}</h3>
          ) : null}
          <div className="rk-options">
            {group.services.map((svc) => {
              const i = index++;
              const range = serviceRange(staff, svc.id);
              const varies = range !== null && range.minCents !== range.maxCents;
              return (
                <label
                  key={svc.id}
                  className="rk-option rk-rise"
                  style={{ "--i": i } as React.CSSProperties}
                >
                  <input
                    className="rk-option__input"
                    type="checkbox"
                    value={svc.id}
                    checked={selectedIds.includes(svc.id)}
                    onChange={() => onToggle(svc.id)}
                  />
                  <span className="rk-option__body">
                    <span className="rk-option__mark">
                      <Check size={16} />
                    </span>
                    <span>
                      <span className="rk-option__name">{svc.name}</span>
                      {svc.description ? (
                        <span className="rk-option__desc">{svc.description}</span>
                      ) : null}
                    </span>
                    <span className="rk-option__facts">
                      <span className="rk-option__price">
                        {varies ? "from " : ""}
                        {formatAud(varies ? range.minCents : svc.priceCents)}
                      </span>
                      {formatDuration(svc.durationMin)}
                    </span>
                  </span>
                </label>
              );
            })}
          </div>
        </div>
      ))}
    </fieldset>
  );
}
