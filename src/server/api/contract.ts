import { z } from "zod";

/**
 * What /api/v1 returns, as strict zod schemas. They generate docs/openapi.json and are checked against real
 * handler responses in tests, so the document cannot drift: a field added or removed on the server fails a
 * test until the schema (and the generated document) are updated. Dates are ISO strings on the wire.
 */

const role = z.enum(["owner", "manager", "stylist", "reception"]);
const isoDate = z.string().describe("ISO 8601 timestamp");
const localDate = z.string().describe("Local calendar date, YYYY-MM-DD");

export const bookingStatus = z.enum([
  "pending_payment",
  "confirmed",
  "completed",
  "cancelled_by_client",
  "cancelled_by_staff",
  "late_cancelled",
  "no_show",
  "expired",
]);

/* Session ------------------------------------------------------------------ */

export const signInResponse = z.strictObject({
  token: z.string().describe("Send as `Authorization: Bearer <token>`"),
  user: z.strictObject({ id: z.string(), email: z.string(), name: z.string().nullable() }),
  role,
  staffId: z.string().nullable(),
});

export const signOutResponse = z.strictObject({ signedOut: z.boolean() });

export const meResponse = z.strictObject({
  userId: z.string(),
  email: z.string(),
  name: z.string().nullable(),
  role,
  staffId: z.string().nullable(),
  permissions: z.array(z.string()),
  business: z.strictObject({ name: z.string(), timezone: z.string() }),
});

export const viewerCaps = z.strictObject({
  role,
  staffId: z.string().nullable(),
  seesAll: z.boolean(),
  createBookings: z.boolean(),
  editBookings: z.boolean(),
  cancelBookings: z.boolean(),
  checkout: z.boolean(),
  reassign: z.boolean(),
  refund: z.boolean(),
  viewClients: z.boolean(),
  editClients: z.boolean(),
  mergeClients: z.boolean(),
});

export const resourcesResponse = z.strictObject({
  timezone: z.string(),
  slotStepMin: z.number(),
  locations: z.array(z.strictObject({ id: z.string(), name: z.string() })),
  staff: z.array(z.strictObject({ id: z.string(), name: z.string(), colour: z.string() })),
  viewer: viewerCaps,
  services: z.array(
    z.strictObject({
      id: z.string(),
      name: z.string(),
      durationMin: z.number(),
      priceCents: z.number(),
      locationIds: z.array(z.string()),
    }),
  ),
});

/* Availability and calendar -------------------------------------------------- */

const slot = z.strictObject({
  staffId: z.string(),
  start: isoDate,
  end: isoDate,
  totalCents: z.number().optional(),
  durationMin: z.number().optional(),
});
export const availabilityResponse = z.strictObject({ slots: z.array(slot) });

export const rescheduleSlotsResponse = z.strictObject({
  current: z.strictObject({ start: isoDate, end: isoDate }),
  slots: z.array(slot),
  reason: z.enum(["services_not_in_catalogue"]).nullable(),
});

const calendarEvent = z.union([
  z.strictObject({
    kind: z.literal("booking"),
    id: z.string(),
    start: isoDate,
    end: isoDate,
    staffId: z.string(),
    locationId: z.string(),
    status: bookingStatus,
    clientId: z.string(),
    clientName: z.string(),
    services: z.array(z.string()),
    totalCents: z.number(),
    source: z.string(),
  }),
  z.strictObject({
    kind: z.enum(["block", "external"]).describe("`external` is read-only busy time from Google"),
    id: z.string(),
    start: isoDate,
    end: isoDate,
    staffId: z.string(),
    reason: z.string().nullable(),
  }),
]);
export const calendarResponse = z.strictObject({ events: z.array(calendarEvent) });

/* Bookings ------------------------------------------------------------------- */

export const bookingRow = z.strictObject({
  id: z.string(),
  start: isoDate,
  end: isoDate,
  status: bookingStatus,
  clientId: z.string(),
  clientName: z.string(),
  locationName: z.string(),
  services: z.array(z.string()),
  totalCents: z.number(),
  staffId: z.string(),
  staffName: z.string(),
  staffColour: z.string(),
});
export const bookingListResponse = z.strictObject({ bookings: z.array(bookingRow) });

const payment = z.strictObject({
  id: z.string(),
  kind: z.enum(["deposit", "balance", "no_show_fee", "late_cancel_fee", "refund"]),
  method: z.enum(["stripe_online", "stripe_in_person", "cash", "eftpos", "other"]),
  status: z.enum(["pending", "succeeded", "failed", "refunded", "partially_refunded"]),
  amountCents: z.number(),
  note: z.string().nullable(),
  createdAt: isoDate,
});

export const bookingDetailResponse = z.strictObject({
  id: z.string(),
  status: bookingStatus,
  start: isoDate,
  end: isoDate,
  source: z.string(),
  comments: z.string().nullable(),
  bookedForOther: z.boolean(),
  intakeAnswers: z.record(z.string(), z.string()),
  cancelReason: z.string().nullable(),
  cancelledAt: isoDate.nullable(),
  location: z.strictObject({ id: z.string(), name: z.string() }),
  staff: z.strictObject({ id: z.string(), name: z.string(), colour: z.string() }),
  client: z.strictObject({
    id: z.string(),
    name: z.string(),
    phone: z.string().nullable(),
    email: z.string().nullable(),
    notes: z.string().nullable(),
    blocked: z.boolean(),
    isVip: z.boolean(),
  }),
  services: z.array(
    z.strictObject({
      id: z.string(),
      name: z.string(),
      durationMin: z.number(),
      priceCents: z.number(),
    }),
  ),
  totalCents: z.number(),
  depositCents: z.number(),
  paidCents: z.number(),
  balanceDueCents: z.number(),
  payments: z.array(payment),
  messages: z.array(
    z.strictObject({
      id: z.string(),
      channel: z.enum(["email", "sms"]),
      template: z.string(),
      status: z.enum(["queued", "sent", "delivered", "failed"]),
      toAddress: z.string(),
      error: z.string().nullable(),
      createdAt: isoDate,
      sentAt: isoDate.nullable(),
    }),
  ),
  audit: z.array(
    z.strictObject({
      id: z.string(),
      actor: z.string(),
      action: z.string(),
      data: z.record(z.string(), z.unknown()),
      at: isoDate,
    }),
  ),
  allowed: z.strictObject({
    move: z.boolean(),
    cancel: z.boolean(),
    noShow: z.boolean(),
    checkout: z.boolean(),
    resend: z.boolean(),
    reassign: z.boolean(),
    refund: z.boolean(),
  }),
  reassignOptions: z.array(z.strictObject({ id: z.string(), name: z.string() })),
});

export const createdBookingResponse = z.strictObject({ bookingId: z.string() });

export const outcomeResponse = z.strictObject({
  bookingId: z.string(),
  status: z.string(),
  depositAction: z.enum(["refund", "keep", "none"]),
  feeCents: z.number(),
});

export const checkoutResponse = z.strictObject({
  totalCents: z.number(),
  paidCents: z.number(),
  balanceDueCents: z.number(),
  cashDiscountCents: z.number(),
  payableCents: z.number(),
  method: z.enum(["cash", "eftpos", "other"]),
  recordedPayment: z.boolean(),
});

/* Clients -------------------------------------------------------------------- */

export const clientSummary = z.strictObject({
  id: z.string(),
  name: z.string(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  isVip: z.boolean(),
  blocked: z.boolean(),
});
export const clientListResponse = z.strictObject({ clients: z.array(clientSummary) });

export const clientProfileResponse = z.strictObject({
  id: z.string(),
  firstName: z.string(),
  lastName: z.string(),
  name: z.string(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  pronouns: z.string().nullable(),
  notes: z.string().nullable(),
  blocked: z.boolean(),
  isVip: z.boolean(),
  marketingOptIn: z.boolean(),
  createdAt: isoDate,
  mergedIntoId: z.string().nullable(),
  stats: z.strictObject({
    completedCount: z.number(),
    noShowCount: z.number(),
    lateCancelCount: z.number(),
    cancelledCount: z.number(),
    upcomingCount: z.number(),
    lifetimeSpendCents: z.number(),
  }),
  history: z.array(bookingRow),
});

/* Payments ------------------------------------------------------------------- */

export const terminalConfigResponse = z.strictObject({
  configured: z.boolean(),
  locationId: z.string().nullable(),
});
export const connectionTokenResponse = z.strictObject({ secret: z.string() });
export const cardPaymentResponse = z.strictObject({
  paymentId: z.string(),
  paymentIntentId: z.string(),
  clientSecret: z.string().describe("For the Stripe Terminal SDK. Treat as a secret."),
  amountCents: z.number(),
});
export const cardPaymentStatusResponse = z.strictObject({
  status: z.enum(["pending", "succeeded", "failed", "refunded", "partially_refunded"]),
  bookingStatus: z.string(),
  balanceDueCents: z.number(),
});

/* Devices -------------------------------------------------------------------- */

export const deviceResponse = z.strictObject({ registered: z.boolean() });

/* Roster and timesheets ------------------------------------------------------ */

const minuteRange = z.strictObject({ startMinute: z.number(), endMinute: z.number() });
const rosterDay = z.strictObject({
  date: localDate,
  entries: z.array(
    z.strictObject({
      locationId: z.string(),
      locationName: z.string(),
      kind: z.enum(["weekly", "custom"]),
      ranges: z.array(minuteRange),
    }),
  ),
  off: z
    .strictObject({
      note: z.string().nullable(),
      everywhere: z.boolean(),
      locationNames: z.array(z.string()),
    })
    .nullable(),
});
export const rosterResponse = z.strictObject({
  weekStart: localDate,
  dates: z.array(localDate),
  locations: z.array(z.strictObject({ id: z.string(), name: z.string() })),
  rows: z.array(
    z.strictObject({
      staffId: z.string(),
      name: z.string(),
      colour: z.string().nullable(),
      days: z.array(rosterDay),
    }),
  ),
  timezone: z.string(),
  today: localDate,
  canEdit: z.boolean(),
  scope: z.enum(["all", "own"]),
});

const exceptionItem = z.strictObject({
  id: z.string(),
  staffId: z.string(),
  staffName: z.string(),
  date: localDate,
  kind: z.enum(["off", "custom"]),
  locationId: z.string().nullable(),
  locationName: z.string().nullable(),
  startMinute: z.number().nullable(),
  endMinute: z.number().nullable(),
  note: z.string().nullable(),
});
export const exceptionListResponse = z.strictObject({ exceptions: z.array(exceptionItem) });
export const exceptionResultResponse = z.strictObject({
  ids: z.array(z.string()),
  conflictingBookings: z
    .number()
    .describe("Existing bookings now outside the roster; never blocks the change"),
});
export const removedResponse = z.strictObject({ removed: z.boolean() });

export const clockResponse = z.discriminatedUnion("available", [
  z.strictObject({ available: z.literal(false) }),
  z.strictObject({
    available: z.literal(true),
    serverNow: isoDate,
    open: z
      .strictObject({ since: isoDate, sinceLabel: z.string(), locationName: z.string().nullable() })
      .nullable(),
    locations: z.array(z.strictObject({ id: z.string(), name: z.string() })),
  }),
]);
export const clockEntryResponse = z.strictObject({ entryId: z.string() });

const timesheetEntry = z.strictObject({
  id: z.string(),
  staffId: z.string(),
  date: localDate,
  locationId: z.string().nullable(),
  locationName: z.string().nullable(),
  clockIn: isoDate,
  clockOut: isoDate.nullable(),
  breakMinutes: z.number(),
  netMinutes: z.number(),
  source: z.enum(["clock", "manual"]),
  note: z.string().nullable(),
  status: z.enum(["open", "pending", "approved"]),
  approvedAt: isoDate.nullable(),
  approvedBy: z.string().nullable(),
});
export const myWeekResponse = z.discriminatedUnion("available", [
  z.strictObject({ available: z.literal(false) }),
  z.strictObject({
    available: z.literal(true),
    sheet: z.strictObject({
      staffId: z.string(),
      staffName: z.string(),
      role,
      weekStart: localDate,
      days: z.array(
        z.strictObject({
          date: localDate,
          complete: z.boolean(),
          workedMinutes: z.number(),
          rosteredMinutes: z.number(),
          differenceMinutes: z.number().nullable(),
          entries: z.array(timesheetEntry),
        }),
      ),
      workedMinutes: z.number(),
      breakMinutes: z.number(),
      rosteredMinutes: z.number(),
      differenceMinutes: z.number(),
      hasOpenEntry: z.boolean(),
      pendingCount: z.number(),
      approvedCount: z.number(),
    }),
  }),
]);

/* Waitlist ------------------------------------------------------------------- */

const waitlistEntry = z.strictObject({
  id: z.string(),
  status: z.enum(["waiting", "offered", "booked", "expired", "cancelled"]),
  clientId: z.string(),
  clientName: z.string(),
  clientPhone: z.string().nullable(),
  clientEmail: z.string().nullable(),
  locationName: z.string(),
  staffName: z.string().nullable(),
  serviceNames: z.array(z.string()),
  earliestDate: localDate,
  latestDate: localDate,
  weekdays: z.array(z.number()).nullable().describe("0 = Sunday ... 6 = Saturday; null = any day"),
  fromMinute: z.number().nullable(),
  toMinute: z.number().nullable(),
  notes: z.string().nullable(),
  createdAt: isoDate,
  offers: z.array(
    z.strictObject({
      id: z.string(),
      status: z.enum(["sent", "claimed", "expired", "slot_taken", "cancelled"]),
      start: isoDate,
      end: isoDate,
      staffName: z.string(),
      offeredBy: z.string(),
      expiresAt: isoDate,
    }),
  ),
});
export const waitlistListResponse = z.strictObject({ entries: z.array(waitlistEntry) });
export const offerableSlotsResponse = z.strictObject({
  entry: waitlistEntry,
  timezone: z.string(),
  slots: z.array(
    z.strictObject({ staffId: z.string(), staffName: z.string(), start: isoDate, end: isoDate }),
  ),
});
export const offerCreatedResponse = z.strictObject({ offerId: z.string() });

/* Errors --------------------------------------------------------------------- */

export const errorResponse = z.strictObject({
  error: z.strictObject({
    code: z.string().describe("Stable. Branch on this."),
    message: z.string().describe("Safe to show to the user."),
    fields: z.record(z.string(), z.string()).optional(),
  }),
});
