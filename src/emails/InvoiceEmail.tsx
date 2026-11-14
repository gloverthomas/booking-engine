import { Layout } from "./Layout";
import { Detail, Heading, Paragraph } from "./parts";
import type { InvoiceEmailProps } from "./props";

export function invoiceSubject(p: InvoiceEmailProps): string {
  return `Your invoice ${p.invoiceNumber} from ${p.businessName}`;
}

export function InvoiceEmail(p: InvoiceEmailProps) {
  return (
    <Layout
      title={`Invoice ${p.invoiceNumber}`}
      businessName={p.businessName}
      preview={`Invoice ${p.invoiceNumber} for ${p.totalLabel} is attached`}
    >
      <Heading>Your invoice</Heading>
      <Paragraph>
        Hi {p.firstName}, thanks for coming in. Your invoice for your appointment with {p.staffName}{" "}
        on {p.dateLabel} is attached as a PDF.
      </Paragraph>
      <Detail label="Invoice">{p.invoiceNumber}</Detail>
      <Detail label="Appointment">
        {p.dateLabel}, {p.timeLabel}
      </Detail>
      <Detail label="Total">{p.totalLabel}</Detail>
    </Layout>
  );
}
