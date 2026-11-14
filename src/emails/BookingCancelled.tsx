import { Layout } from "./Layout";
import { Button, Detail, Heading, Notice, Paragraph, PriceTable, SectionLabel } from "./parts";
import type { BookingCancelledProps } from "./props";

export function cancelledSubject(p: BookingCancelledProps): string {
  return `Your appointment on ${p.dateLabel} has been cancelled`;
}

/** The one sentence the client cares about most: is the deposit coming back? */
export function depositSentence(p: BookingCancelledProps): string {
  if (p.depositOutcome === "refund" && p.depositLabel) {
    return `Your deposit of ${p.depositLabel} is being refunded to the card you paid with. It can take 5 to 10 business days to appear.`;
  }
  if (p.depositOutcome === "keep" && p.depositLabel) {
    return `Your deposit of ${p.depositLabel} is not refunded, in line with our cancellation policy.`;
  }
  return "No deposit was taken for this appointment, so there is nothing to refund.";
}

export function BookingCancelled(p: BookingCancelledProps) {
  const who =
    p.cancelledBy === "staff"
      ? `Hi ${p.firstName}, we have had to cancel your appointment with ${p.staffName}. We are sorry for the inconvenience.`
      : `Hi ${p.firstName}, your appointment with ${p.staffName} has been cancelled as requested.`;
  return (
    <Layout
      title="Your appointment has been cancelled"
      businessName={p.businessName}
      preview={`${p.dateLabel} at ${p.timeLabel} is cancelled. ${depositSentence(p)}`}
    >
      <Heading>Appointment cancelled</Heading>
      <Paragraph>{who}</Paragraph>
      <Detail label="Was booked for">
        {p.dateLabel}
        <br />
        {p.timeLabel}, {p.locationName}
      </Detail>
      <SectionLabel>Services</SectionLabel>
      <PriceTable lines={p.services.map((s) => ({ label: s.name, value: s.price }))} />
      <Notice>
        <strong>Your deposit.</strong> {depositSentence(p)}
      </Notice>
      {p.feeLabel ? (
        <Notice>
          <strong>Cancellation fee.</strong> A fee of {p.feeLabel} will be charged to the card you
          booked with.
        </Notice>
      ) : null}
      {p.policyText ? <Paragraph muted>{p.policyText}</Paragraph> : null}
      <Button href={p.rebookUrl}>Book another time</Button>
    </Layout>
  );
}
