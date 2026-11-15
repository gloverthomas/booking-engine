/** Wire types for the public waitlist API. Type-only, so browser code may import them. */

export interface WaitlistJoinedData {
  /** Lets the person leave again; the same link is in every message we send them. */
  leaveToken: string;
}

export interface WaitlistOfferData {
  offerId: string;
  /** "sent" can be claimed; the rest explain why not. */
  status: "sent" | "claimed" | "expired" | "slot_taken" | "cancelled";
  /** ISO instants (UTC). */
  start: string;
  end: string;
  expiresAt: string;
  /** Server clock, to correct for the visitor's clock. */
  serverNow: string;
  timezone: string;
  businessName: string;
  staffName: string;
  locationName: string;
  locationAddress: string | null;
  services: Array<{ name: string; priceCents: number }>;
  totalCents: number;
  depositCents: number;
  policy: { version: string; text: string; cancelWindowHours: number; depositPct: number };
  bookingStatus: string | null;
  /** The claimed booking's manage token, once claimed. */
  manageToken: string | null;
  /** Claimed and the deposit can still be paid. */
  resumable: boolean;
}

export interface WaitlistClaimData {
  bookingId: string;
  manageToken: string;
  holdExpiresAt: string;
  serverNow: string;
  totalCents: number;
  depositCents: number;
  start: string;
  end: string;
  /** True when no deposit was due and the booking is already confirmed. */
  confirmed: boolean;
  payment: { clientSecret: string; paymentId: string; amountCents: number } | null;
  billing: { name: string; email: string; phone: string };
}

export interface WaitlistEntryData {
  status: "waiting" | "offered" | "booked" | "expired" | "cancelled";
  locationName: string;
  staffName: string | null;
  serviceNames: string[];
  earliestDate: string;
  latestDate: string;
  /** Pre-rendered for display. */
  daysLabel: string;
  timeLabel: string;
}

export interface WaitlistLeftData {
  left: true;
}
