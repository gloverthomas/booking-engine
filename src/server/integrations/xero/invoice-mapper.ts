import { DateTime } from "luxon";
import type { BookingBundle } from "../common/booking-data";
import type { XeroConfig } from "./config";
import type { LineAmountTypes, XeroLine } from "./port";

/** Local calendar date (YYYY-MM-DD) in the business time zone. */
export function localDate(date: Date, timeZone: string): string {
  return (
    DateTime.fromJSDate(date, { zone: timeZone }).toISODate() ?? date.toISOString().slice(0, 10)
  );
}

/** NoTax when the business does not charge GST; GST-inclusive amounts otherwise. */
export function amountTypesFor(config: XeroConfig): LineAmountTypes {
  return config.taxType === "NONE" ? "NoTax" : "Inclusive";
}

/** One line for a single charge (a fee, a refund, a write-off). */
export function singleLine(description: string, amountCents: number, config: XeroConfig): XeroLine {
  return {
    description,
    quantity: 1,
    unitAmountCents: amountCents,
    accountCode: config.revenueAccountCode,
    ...(config.taxType === "NONE" ? {} : { taxType: config.taxType }),
  };
}

/**
 * One line per booked service (the snapshot taken at booking time). If the services do not add
 * up to the booking total (e.g. an adjustment was applied), an "Adjustment" line makes the
 * invoice match what the client was actually charged.
 */
export function invoiceLines(bundle: BookingBundle, config: XeroConfig): XeroLine[] {
  const lines = bundle.services.map((s) => singleLine(s.name, s.priceCents, config));
  const listed = bundle.services.reduce((sum, s) => sum + s.priceCents, 0);
  const difference = bundle.booking.totalCents - listed;
  if (lines.length === 0) {
    return [singleLine("Appointment", bundle.booking.totalCents, config)];
  }
  if (difference !== 0) lines.push(singleLine("Adjustment", difference, config));
  return lines;
}
