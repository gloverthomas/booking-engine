import { describe, expect, test } from "vitest";
import {
  renderBookingCancelled,
  renderBookingConfirmation,
  renderBookingMoved,
  renderInvoiceEmail,
  renderOwnerAlert,
  type BookingCancelledProps,
  type BookingConfirmationProps,
  type BookingMovedProps,
  type InvoiceEmailProps,
  type OwnerAlertProps,
} from "@/emails";

const confirmation: BookingConfirmationProps = {
  businessName: "Ryan Kennedy Hairdressing",
  firstName: "Sam",
  staffName: "Ryan Kennedy",
  dateLabel: "Saturday 14 November 2026",
  timeLabel: "2:15 PM",
  services: [
    { name: "Maintenance Haircut", price: "$95.00" },
    { name: "Beard Trim", price: "$30.00" },
  ],
  totalLabel: "$125.00",
  locationName: "Northside",
  address: "12 Smith St, Northcote VIC 3070",
  arrivalNote: "Please arrive 10 minutes early. Parking is limited.",
  depositPaidLabel: "$62.50",
  balanceDueLabel: "$62.50",
  policyText: "Cancellations within 24 hours forfeit the deposit.",
  manageUrl: "https://book.example.com/manage/abc.def",
  hasCalendarFile: true,
};

const moved: BookingMovedProps = {
  businessName: confirmation.businessName,
  firstName: "Sam",
  staffName: "Ryan Kennedy",
  dateLabel: "Sunday 15 November 2026",
  timeLabel: "10:00 AM",
  previousDateLabel: "Saturday 14 November 2026",
  previousTimeLabel: "2:15 PM",
  services: confirmation.services,
  totalLabel: "$125.00",
  locationName: "Northside",
  address: confirmation.address,
  manageUrl: confirmation.manageUrl,
  policyText: "",
  hasCalendarFile: true,
};

const cancelled: BookingCancelledProps = {
  businessName: confirmation.businessName,
  firstName: "Sam",
  staffName: "Ryan Kennedy",
  dateLabel: "Saturday 14 November 2026",
  timeLabel: "2:15 PM",
  services: confirmation.services,
  locationName: "Northside",
  cancelledBy: "client",
  depositOutcome: "refund",
  depositLabel: "$62.50",
  feeLabel: null,
  policyText: "Cancellations within 24 hours forfeit the deposit.",
  rebookUrl: "https://book.example.com/book",
};

const invoice: InvoiceEmailProps = {
  businessName: confirmation.businessName,
  firstName: "Sam",
  staffName: "Ryan Kennedy",
  invoiceNumber: "INV-0042",
  dateLabel: "Saturday 14 November 2026",
  timeLabel: "2:15 PM",
  totalLabel: "$125.00",
};

const owner: OwnerAlertProps = {
  businessName: confirmation.businessName,
  kind: "new",
  clientName: "Sam Client",
  clientPhone: "+61410123456",
  clientEmail: "sam@example.com",
  dateLabel: "Saturday 14 November 2026",
  timeLabel: "2:15 PM",
  previousWhen: null,
  services: confirmation.services,
  totalLabel: "$125.00",
  locationName: "Northside",
  depositLabel: "$62.50",
  depositOutcome: null,
  comments: "Bringing a reference photo",
};

describe("booking confirmation email", () => {
  test("renders html and plain text with the manage button, location and payment split", async () => {
    const email = await renderBookingConfirmation(confirmation);

    expect(email.subject).toBe("Your appointment is booked: Saturday 14 November 2026 at 2:15 PM");
    expect(email.html).toContain('href="https://book.example.com/manage/abc.def"');
    expect(email.html).toContain("View or change my appointment");
    expect(email.html).toContain("12 Smith St, Northcote VIC 3070");
    expect(email.html).toContain("Please arrive 10 minutes early");
    expect(email.html).toContain("Cancellations within 24 hours forfeit the deposit.");
    expect(email.text).toContain("https://book.example.com/manage/abc.def");
    expect(email.text).toContain("Northside");
    expect(email.text).toContain("$62.50");
    expect(email.text).not.toContain("<");
  });

  test("declares light and dark colour schemes and a dark palette", async () => {
    const { html } = await renderBookingConfirmation(confirmation);
    expect(html).toContain('name="color-scheme" content="light dark"');
    expect(html).toContain("prefers-color-scheme: dark");
    expect(html.toLowerCase()).toContain("text-transform:uppercase");
  });

  test("omits the deposit line when none was paid and the policy box when there is no policy", async () => {
    const { html } = await renderBookingConfirmation({
      ...confirmation,
      depositPaidLabel: null,
      policyText: "",
      hasCalendarFile: false,
    });
    expect(html).not.toContain("Deposit paid");
    expect(html).not.toContain("Cancellation policy.");
    expect(html).not.toContain("calendar file is attached");
  });

  test("html snapshot", async () => {
    const { html, text } = await renderBookingConfirmation(confirmation);
    expect(html).toMatchSnapshot();
    expect(text).toMatchSnapshot();
  });
});

describe("booking moved email", () => {
  test("shows old and new time", async () => {
    const email = await renderBookingMoved(moved);
    expect(email.subject).toContain("Sunday 15 November 2026 at 10:00 AM");
    expect(email.text).toContain("Saturday 14 November 2026");
    expect(email.text).toContain("10:00 AM");
    expect(email.html).not.toContain("Cancellation policy.");
  });

  test("html snapshot", async () => {
    expect((await renderBookingMoved(moved)).html).toMatchSnapshot();
  });
});

describe("booking cancelled email", () => {
  test("states the deposit is being refunded", async () => {
    const email = await renderBookingCancelled(cancelled);
    expect(email.text).toContain("Your deposit of $62.50 is being refunded");
    expect(email.text).not.toContain("not refunded");
  });

  test("states the deposit is kept on a late cancellation", async () => {
    const email = await renderBookingCancelled({
      ...cancelled,
      depositOutcome: "keep",
      feeLabel: "$25.00",
    });
    expect(email.text).toContain("Your deposit of $62.50 is not refunded");
    expect(email.text).toContain("$25.00");
  });

  test("says nothing to refund when no deposit was taken", async () => {
    const email = await renderBookingCancelled({
      ...cancelled,
      depositOutcome: "none",
      depositLabel: null,
    });
    expect(email.text).toContain("No deposit was taken");
  });

  test("apologises when the business cancels", async () => {
    const email = await renderBookingCancelled({ ...cancelled, cancelledBy: "staff" });
    expect(email.text).toContain("we have had to cancel");
  });

  test("html snapshot", async () => {
    expect((await renderBookingCancelled(cancelled)).html).toMatchSnapshot();
  });
});

describe("invoice and owner alert emails", () => {
  test("invoice mentions the attached PDF and number", async () => {
    const email = await renderInvoiceEmail(invoice);
    expect(email.subject).toBe("Your invoice INV-0042 from Ryan Kennedy Hairdressing");
    expect(email.text).toContain("INV-0042");
    expect(email.text).toContain("attached");
  });

  test.each([
    ["new", "New booking"],
    ["rescheduled", "Booking moved"],
    ["cancelled", "Booking cancelled"],
  ] as const)("owner alert (%s)", async (kind, headline) => {
    const email = await renderOwnerAlert({
      ...owner,
      kind,
      previousWhen: kind === "rescheduled" ? "Friday 13 November 2026, 9:00 AM" : null,
      depositOutcome: kind === "cancelled" ? "keep" : null,
    });
    expect(email.subject).toContain(headline);
    expect(email.text).toContain("Sam Client");
    expect(email.text).toContain("+61410123456");
    if (kind === "cancelled") expect(email.text).toContain("Deposit kept");
    if (kind === "rescheduled") expect(email.text).toContain("Friday 13 November 2026");
  });

  test("owner alert html snapshot", async () => {
    expect((await renderOwnerAlert(owner)).html).toMatchSnapshot();
  });
});
