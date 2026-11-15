import { Layout } from "./Layout";
import { Detail, Heading, Paragraph } from "./parts";
import type { StaffAlertKind, StaffAlertProps } from "./props";

const HEADLINES: Record<StaffAlertKind, string> = {
  new: "New booking",
  moved: "Booking moved",
  assigned: "Booking assigned to you",
  moved_away: "Booking moved away from you",
  cancelled: "Booking cancelled",
};

const INTROS: Record<StaffAlertKind, string> = {
  new: "has been booked with you.",
  moved: "has been moved to a new time.",
  assigned: "has been assigned to you.",
  moved_away: "is no longer with you: it has moved to another stylist.",
  cancelled: "has been cancelled.",
};

export function staffAlertSubject(p: StaffAlertProps): string {
  return `${HEADLINES[p.kind]}: ${p.clientFirstName}, ${p.dateLabel} ${p.timeLabel}`;
}

/** Sent to the stylist. Deliberately carries no client phone or email. */
export function StaffAlert(p: StaffAlertProps) {
  return (
    <Layout
      title={staffAlertSubject(p)}
      businessName={p.businessName}
      preview={`${p.clientFirstName} on ${p.dateLabel} at ${p.timeLabel}`}
    >
      <Heading>{HEADLINES[p.kind]}</Heading>
      <Paragraph>{`Hi ${p.staffFirstName}, ${p.clientFirstName}'s appointment ${INTROS[p.kind]}`}</Paragraph>
      <Detail label={p.kind === "moved_away" ? "Was" : "When"}>
        {p.dateLabel}
        <br />
        {p.timeLabel}
      </Detail>
      {p.kind === "moved" ? <Detail label="Previously">{p.previousWhen}</Detail> : null}
      <Detail label="Client">{p.clientFirstName}</Detail>
      <Detail label="Services">{p.services.join(", ")}</Detail>
      <Detail label="Where">{p.locationName}</Detail>
    </Layout>
  );
}
