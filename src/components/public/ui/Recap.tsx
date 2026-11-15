import { formatInstant } from "@/lib/public-api-time";

interface RecapProps {
  whenIso: string;
  timezone: string;
  locationName: string | null;
  serviceNames: readonly string[];
  /** Who the booking is with, when clients choose their stylist. */
  staffName?: string | null;
}

/** One-glance reminder of what is being booked, shown above the details and payment steps. */
export function Recap({ whenIso, timezone, locationName, serviceNames, staffName }: RecapProps) {
  return (
    <div className="rk-recap">
      <p className="rk-recap__when">{formatInstant(whenIso, timezone)}</p>
      <p className="rk-recap__what">
        {serviceNames.join(" + ")}
        {staffName ? ` · with ${staffName}` : ""}
        {locationName ? ` · ${locationName}` : ""}
      </p>
    </div>
  );
}
