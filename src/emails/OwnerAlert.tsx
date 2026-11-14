import { Layout } from "./Layout";
import { Detail, Heading, Paragraph, PriceTable, SectionLabel } from "./parts";
import type { OwnerAlertKind, OwnerAlertProps } from "./props";

const HEADLINES: Record<OwnerAlertKind, string> = {
  new: "New booking",
  rescheduled: "Booking moved",
  cancelled: "Booking cancelled",
};

const VERBS: Record<OwnerAlertKind, string> = {
  new: "booked",
  rescheduled: "moved",
  cancelled: "cancelled",
};

const OUTCOME_TEXT = {
  refund: "Deposit is being refunded",
  keep: "Deposit kept (late cancellation)",
  none: "No deposit was taken",
} as const;

export function ownerAlertSubject(p: OwnerAlertProps): string {
  return `${HEADLINES[p.kind]}: ${p.clientName}, ${p.dateLabel} ${p.timeLabel}`;
}

export function OwnerAlert(p: OwnerAlertProps) {
  return (
    <Layout
      title={ownerAlertSubject(p)}
      businessName={p.businessName}
      preview={`${p.clientName} on ${p.dateLabel} at ${p.timeLabel}`}
    >
      <Heading>{HEADLINES[p.kind]}</Heading>
      <Paragraph>{`${p.clientName} ${VERBS[p.kind]} an appointment at ${p.locationName}.`}</Paragraph>
      <Detail label="When">
        {p.dateLabel}
        <br />
        {p.timeLabel}
      </Detail>
      <Detail label="Previously">{p.previousWhen}</Detail>
      <Detail label="Client">
        {p.clientName}
        {p.clientPhone ? (
          <>
            <br />
            {p.clientPhone}
          </>
        ) : null}
        {p.clientEmail ? (
          <>
            <br />
            {p.clientEmail}
          </>
        ) : null}
      </Detail>
      <SectionLabel>Services</SectionLabel>
      <PriceTable
        lines={[
          ...p.services.map((s) => ({ label: s.name, value: s.price })),
          { label: "Total", value: p.totalLabel, strong: true },
        ]}
      />
      <Detail label="Deposit">
        {p.kind === "cancelled" && p.depositOutcome
          ? OUTCOME_TEXT[p.depositOutcome]
          : p.depositLabel}
      </Detail>
      <Detail label="Client notes">{p.comments}</Detail>
    </Layout>
  );
}
