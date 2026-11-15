import { AppointmentDetails } from "./AppointmentDetails";
import { Layout } from "./Layout";
import { Button, Heading, Notice, Paragraph } from "./parts";
import type { PriceLineProp } from "./props";
import { light } from "./theme";

/** Display-ready strings, like every other email's props. */
export interface WaitlistOfferProps {
  businessName: string;
  firstName: string;
  staffName: string;
  dateLabel: string;
  timeLabel: string;
  services: PriceLineProp[];
  totalLabel: string;
  locationName: string;
  address: string;
  /** Deposit to pay to secure the time. */
  depositLabel: string;
  /** How long the time is held for, e.g. "20 minutes". */
  windowLabel: string;
  /** When the hold ends, e.g. "2:35 PM". */
  heldUntilLabel: string;
  claimUrl: string;
  leaveUrl: string;
}

export function waitlistOfferSubject(p: WaitlistOfferProps): string {
  return `A time has opened up: ${p.dateLabel} at ${p.timeLabel}`;
}

export function WaitlistOffer(p: WaitlistOfferProps) {
  return (
    <Layout
      title="A time has opened up"
      businessName={p.businessName}
      preview={`${p.dateLabel} at ${p.timeLabel} with ${p.staffName}. First to pay the deposit gets it.`}
    >
      <Heading>A time has opened up</Heading>
      <Paragraph>
        Hi {p.firstName}, you asked to hear when a time came free. {p.staffName} has an opening that
        suits you.
      </Paragraph>
      <AppointmentDetails
        dateLabel={p.dateLabel}
        timeLabel={p.timeLabel}
        services={p.services}
        locationName={p.locationName}
        address={p.address}
      />
      <Notice>
        <strong>First to pay the deposit gets it.</strong> This time is held for you for{" "}
        {p.windowLabel} (until {p.heldUntilLabel}). Pay the {p.depositLabel} deposit by then to
        secure it. We may have offered it to others too, and once it is taken it is gone.
      </Notice>
      <Button href={p.claimUrl}>Claim this time</Button>
      <Paragraph muted>
        Not interested? You will stay on the waitlist for other openings. You will only be messaged
        about openings.{" "}
        <a href={p.leaveUrl} style={{ color: light.muted }}>
          Leave the waitlist
        </a>
        .
      </Paragraph>
    </Layout>
  );
}
