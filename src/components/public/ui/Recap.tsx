import { formatInstant } from "@/lib/public-api-time";

interface RecapProps {
  whenIso: string;
  timezone: string;
  locationName: string | null;
  serviceNames: readonly string[];
}

/** One-glance reminder of what is being booked, shown above the details and payment steps. */
export function Recap({ whenIso, timezone, locationName, serviceNames }: RecapProps) {
  return (
    <div className="rk-recap">
      <p className="rk-recap__when">{formatInstant(whenIso, timezone)}</p>
      <p className="rk-recap__what">
        {serviceNames.join(" + ")}
        {locationName ? ` · ${locationName}` : ""}
      </p>
    </div>
  );
}
