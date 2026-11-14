import { AppointmentDetails } from "./AppointmentDetails";
import { Layout } from "./Layout";
import { Button, Heading, Notice, Paragraph } from "./parts";
import type { BookingMovedProps } from "./props";

export function movedSubject(p: BookingMovedProps): string {
  return `Your appointment has moved to ${p.dateLabel} at ${p.timeLabel}`;
}

export function BookingMoved(p: BookingMovedProps) {
  return (
    <Layout
      title="Your appointment has moved"
      businessName={p.businessName}
      preview={`New time: ${p.dateLabel} at ${p.timeLabel}`}
    >
      <Heading>Appointment moved</Heading>
      <Paragraph>
        Hi {p.firstName}, your appointment with {p.staffName} has been moved from{" "}
        {p.previousDateLabel} at {p.previousTimeLabel} to the time below.
      </Paragraph>
      <AppointmentDetails
        dateLabel={p.dateLabel}
        timeLabel={p.timeLabel}
        services={p.services}
        locationName={p.locationName}
        address={p.address}
        arrivalNote={p.arrivalNote}
      />
      <Button href={p.manageUrl}>View or change my appointment</Button>
      {p.hasCalendarFile ? (
        <Paragraph muted>An updated calendar file is attached.</Paragraph>
      ) : null}
      {p.policyText ? (
        <Notice>
          <strong>Cancellation policy.</strong> {p.policyText}
        </Notice>
      ) : null}
    </Layout>
  );
}
