import { AppointmentDetails } from "./AppointmentDetails";
import { Layout } from "./Layout";
import { Button, Heading, Notice, Paragraph, PriceTable, SectionLabel } from "./parts";
import type { BookingConfirmationProps } from "./props";

export function confirmationSubject(p: BookingConfirmationProps): string {
  return `Your appointment is booked: ${p.dateLabel} at ${p.timeLabel}`;
}

export function BookingConfirmation(p: BookingConfirmationProps) {
  const payment = [
    { label: "Total", value: p.totalLabel },
    ...(p.depositPaidLabel ? [{ label: "Deposit paid", value: p.depositPaidLabel }] : []),
    { label: "Balance due at your appointment", value: p.balanceDueLabel, strong: true },
  ];
  return (
    <Layout
      title="Your appointment is booked"
      businessName={p.businessName}
      preview={`${p.dateLabel} at ${p.timeLabel}, ${p.locationName}`}
    >
      <Heading>You&apos;re booked in</Heading>
      <Paragraph>
        Hi {p.firstName}, your appointment with {p.staffName} is confirmed.
      </Paragraph>
      <AppointmentDetails
        dateLabel={p.dateLabel}
        timeLabel={p.timeLabel}
        services={p.services}
        locationName={p.locationName}
        address={p.address}
        arrivalNote={p.arrivalNote}
      />
      <SectionLabel>Payment</SectionLabel>
      <PriceTable lines={payment} />
      <Button href={p.manageUrl}>View or change my appointment</Button>
      {p.hasCalendarFile ? (
        <Paragraph muted>
          A calendar file is attached so you can add this to your calendar.
        </Paragraph>
      ) : null}
      {p.policyText ? (
        <Notice>
          <strong>Cancellation policy.</strong> {p.policyText}
        </Notice>
      ) : null}
    </Layout>
  );
}
