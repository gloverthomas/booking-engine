/**
 * OWNER: workstream W6 (waitlist). The booking page shows this when a day has no times. Replace the stub,
 * keeping the props. Until then it is a plain link.
 */
export interface JoinWaitlistCtaProps {
  locationId: string;
  serviceIds: string[];
  /** Local date (YYYY-MM-DD) the client was looking at. */
  date?: string;
  staffId?: string;
}

export function JoinWaitlistCta({ locationId, serviceIds, date, staffId }: JoinWaitlistCtaProps) {
  const params = new URLSearchParams({ location: locationId, services: serviceIds.join(",") });
  if (date) params.set("date", date);
  if (staffId) params.set("staff", staffId);
  return <a href={`/waitlist/join?${params.toString()}`}>Join the waitlist</a>;
}
