import { Layout } from "./Layout";
import { Detail, Heading, Notice, Paragraph } from "./parts";
import type { FeeChargedProps } from "./props";

export function feeChargedSubject(p: FeeChargedProps): string {
  return p.kind === "no_show_fee"
    ? `A missed-appointment fee of ${p.feeLabel} was charged`
    : `A late-cancellation fee of ${p.feeLabel} was charged`;
}

export function feeReason(p: FeeChargedProps): string {
  return p.kind === "no_show_fee"
    ? `you did not arrive for your appointment on ${p.dateLabel} at ${p.timeLabel}`
    : `your appointment on ${p.dateLabel} at ${p.timeLabel} was cancelled inside our cancellation window`;
}

export function FeeCharged(p: FeeChargedProps) {
  return (
    <Layout
      title="A fee was charged"
      businessName={p.businessName}
      preview={`${p.feeLabel} was charged to the card you booked with.`}
    >
      <Heading>
        {p.kind === "no_show_fee" ? "Missed appointment fee" : "Late cancellation fee"}
      </Heading>
      <Paragraph>
        Hi {p.firstName}, we have charged {p.feeLabel} to the card you booked with because{" "}
        {feeReason(p)}.
      </Paragraph>
      <Detail label="Appointment">
        {p.dateLabel}
        <br />
        {p.timeLabel}, {p.locationName}
      </Detail>
      <Notice>
        <strong>Amount charged.</strong> {p.feeLabel}
      </Notice>
      {p.policyText ? <Paragraph muted>{p.policyText}</Paragraph> : null}
      <Paragraph muted>If you think this is a mistake, please reply to this email.</Paragraph>
    </Layout>
  );
}
