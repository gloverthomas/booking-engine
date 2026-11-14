import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { tstzrange } from "./tstzrange";

/* -------------------------------------------------------------------------- */
/* Enums                                                                      */
/* -------------------------------------------------------------------------- */

export const bookingStatus = pgEnum("booking_status", [
  "pending_payment",
  "confirmed",
  "completed",
  "cancelled_by_client",
  "cancelled_by_staff",
  "late_cancelled",
  "no_show",
  "expired",
]);

/** Statuses that occupy a slot. Keep in sync with the exclusion constraint in the migration. */
export const SLOT_HOLDING_STATUSES = ["pending_payment", "confirmed"] as const;

export const paymentKind = pgEnum("payment_kind", [
  "deposit",
  "balance",
  "no_show_fee",
  "late_cancel_fee",
  "refund",
]);

export const paymentMethod = pgEnum("payment_method", [
  "stripe_online",
  "stripe_in_person",
  "cash",
  "eftpos",
  "other",
]);

export const paymentStatus = pgEnum("payment_status", [
  "pending",
  "succeeded",
  "failed",
  "refunded",
  "partially_refunded",
]);

export const messageChannel = pgEnum("message_channel", ["email", "sms"]);
export const messageStatus = pgEnum("message_status", ["queued", "sent", "delivered", "failed"]);

export const integrationProvider = pgEnum("integration_provider", ["google", "xero", "stripe"]);
export const integrationStatus = pgEnum("integration_status", [
  "connected",
  "error",
  "disconnected",
]);

export const timeBlockSource = pgEnum("time_block_source", ["manual", "google"]);

/* -------------------------------------------------------------------------- */
/* Business, places, people                                                   */
/* -------------------------------------------------------------------------- */

/** Single-tenant today (one row). `settings` is validated by BusinessSettings in src/server/settings.ts. */
export const business = pgTable("business", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  timezone: text("timezone").notNull().default("Australia/Melbourne"),
  abn: text("abn"),
  settings: jsonb("settings")
    .$type<Record<string, unknown>>()
    .notNull()
    .default(sql`'{}'::jsonb`),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const location = pgTable("location", {
  id: uuid("id").primaryKey().defaultRandom(),
  businessId: uuid("business_id").references(() => business.id),
  name: text("name").notNull(),
  addressLine: text("address_line"),
  suburb: text("suburb"),
  state: text("state"),
  postcode: text("postcode"),
  phone: text("phone"),
  /** Shown to clients in confirmations (e.g. "Please arrive 10 minutes early, parking is limited"). */
  arrivalNote: text("arrival_note"),
  active: boolean("active").notNull().default(true),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const staff = pgTable("staff", {
  id: uuid("id").primaryKey().defaultRandom(),
  businessId: uuid("business_id").references(() => business.id),
  name: text("name").notNull(),
  email: text("email"),
  /** Seniority tier for future per-level pricing (see priceFor in the plan). */
  level: integer("level").notNull().default(0),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const service = pgTable("service", {
  id: uuid("id").primaryKey().defaultRandom(),
  businessId: uuid("business_id").references(() => business.id),
  name: text("name").notNull(),
  description: text("description"),
  category: text("category"),
  durationMin: integer("duration_min").notNull(),
  priceCents: integer("price_cents").notNull(),
  /** Padding after the appointment, not shown to the client. */
  bufferMin: integer("buffer_min").notNull().default(0),
  /** Overrides the business deposit percentage for this service when set (0 to 100). */
  depositPct: integer("deposit_pct"),
  vipOnly: boolean("vip_only").notNull().default(false),
  /** [{ id, label, required }] extra questions shown when this service is selected. */
  intakeQuestions: jsonb("intake_questions")
    .$type<Array<{ id: string; label: string; required: boolean }>>()
    .notNull()
    .default(sql`'[]'::jsonb`),
  active: boolean("active").notNull().default(true),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const serviceLocation = pgTable(
  "service_location",
  {
    serviceId: uuid("service_id")
      .notNull()
      .references(() => service.id, { onDelete: "cascade" }),
    locationId: uuid("location_id")
      .notNull()
      .references(() => location.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.serviceId, t.locationId] })],
);

/** Who offers a service. Null overrides fall back to the service defaults (always resolve via priceFor). */
export const serviceStaff = pgTable(
  "service_staff",
  {
    serviceId: uuid("service_id")
      .notNull()
      .references(() => service.id, { onDelete: "cascade" }),
    staffId: uuid("staff_id")
      .notNull()
      .references(() => staff.id, { onDelete: "cascade" }),
    priceCents: integer("price_cents"),
    durationMin: integer("duration_min"),
  },
  (t) => [primaryKey({ columns: [t.serviceId, t.staffId] })],
);

/** Recurring weekly hours at a location. Minutes are local to the business timezone. */
export const availabilityRule = pgTable(
  "availability_rule",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    staffId: uuid("staff_id")
      .notNull()
      .references(() => staff.id, { onDelete: "cascade" }),
    locationId: uuid("location_id")
      .notNull()
      .references(() => location.id, { onDelete: "cascade" }),
    /** 0 = Sunday ... 6 = Saturday */
    weekday: integer("weekday").notNull(),
    startMinute: integer("start_minute").notNull(),
    endMinute: integer("end_minute").notNull(),
    /** Local dates (YYYY-MM-DD) bounding when the rule applies. Null = open ended. */
    validFrom: text("valid_from"),
    validTo: text("valid_to"),
  },
  (t) => [
    check("availability_weekday_range", sql`${t.weekday} BETWEEN 0 AND 6`),
    check(
      "availability_minutes_range",
      sql`${t.startMinute} >= 0 AND ${t.endMinute} <= 1440 AND ${t.startMinute} < ${t.endMinute}`,
    ),
    index("availability_rule_staff_idx").on(t.staffId),
  ],
);

/** Unavailable time: leave, appointments elsewhere, and busy time imported from Google. */
export const timeBlock = pgTable(
  "time_block",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    staffId: uuid("staff_id")
      .notNull()
      .references(() => staff.id, { onDelete: "cascade" }),
    during: tstzrange("during").notNull(),
    reason: text("reason"),
    source: timeBlockSource("source").notNull().default("manual"),
    /** Google event id for imported blocks, used to upsert/delete on sync. */
    externalId: text("external_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("time_block_during_not_empty", sql`NOT isempty(${t.during})`),
    uniqueIndex("time_block_external_uidx").on(t.staffId, t.source, t.externalId),
  ],
);

export const client = pgTable(
  "client",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    businessId: uuid("business_id").references(() => business.id),
    firstName: text("first_name").notNull(),
    lastName: text("last_name").notNull().default(""),
    email: text("email"),
    /** E.164, e.g. +61410123456 */
    phone: text("phone"),
    pronouns: text("pronouns"),
    notes: text("notes"),
    marketingOptIn: boolean("marketing_opt_in").notNull().default(false),
    blocked: boolean("blocked").notNull().default(false),
    isVip: boolean("is_vip").notNull().default(false),
    stripeCustomerId: text("stripe_customer_id"),
    xeroContactId: text("xero_contact_id"),
    mergedIntoId: uuid("merged_into_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("client_email_idx").on(t.email), index("client_phone_idx").on(t.phone)],
);

/* -------------------------------------------------------------------------- */
/* Bookings and payments                                                      */
/* -------------------------------------------------------------------------- */

/**
 * The `no_overlap` exclusion constraint (staff_id WITH =, during WITH &&) lives in the SQL
 * migration because Drizzle cannot express exclusion constraints. It is what makes
 * double-booking impossible even under concurrent requests.
 */
export const booking = pgTable(
  "booking",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    staffId: uuid("staff_id")
      .notNull()
      .references(() => staff.id),
    locationId: uuid("location_id")
      .notNull()
      .references(() => location.id),
    clientId: uuid("client_id")
      .notNull()
      .references(() => client.id),
    status: bookingStatus("status").notNull().default("pending_payment"),
    /** The time the client is occupying the stylist, including any service buffer. */
    during: tstzrange("during").notNull(),
    totalCents: integer("total_cents").notNull().default(0),
    depositCents: integer("deposit_cents").notNull().default(0),
    holdExpiresAt: timestamp("hold_expires_at", { withTimezone: true }),
    bookedForOther: boolean("booked_for_other").notNull().default(false),
    comments: text("comments"),
    /** Answers to per-service intake questions: { [questionId]: answer } */
    intakeAnswers: jsonb("intake_answers")
      .$type<Record<string, string>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    source: text("source").notNull().default("online"),
    /** Evidence for late-cancel fees: when and which version of the policy the client accepted. */
    policyAcceptedAt: timestamp("policy_accepted_at", { withTimezone: true }),
    policyVersion: text("policy_version"),
    /** SHA-256 of the manage-booking token; the raw token only ever appears in links we send. */
    manageTokenHash: text("manage_token_hash"),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    cancelReason: text("cancel_reason"),
    gcalEventId: text("gcal_event_id"),
    xeroInvoiceId: text("xero_invoice_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("booking_during_not_empty", sql`NOT isempty(${t.during})`),
    index("booking_client_idx").on(t.clientId),
    index("booking_status_idx").on(t.status),
    uniqueIndex("booking_manage_token_uidx").on(t.manageTokenHash),
  ],
);

/** Snapshot of each service at booking time, so later price/duration edits never rewrite history. */
export const bookingService = pgTable(
  "booking_service",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    bookingId: uuid("booking_id")
      .notNull()
      .references(() => booking.id, { onDelete: "cascade" }),
    serviceId: uuid("service_id").references(() => service.id),
    name: text("name").notNull(),
    durationMin: integer("duration_min").notNull(),
    priceCents: integer("price_cents").notNull(),
    position: integer("position").notNull().default(0),
  },
  (t) => [index("booking_service_booking_idx").on(t.bookingId)],
);

/** bookingId is nullable so in-person Stripe payments can arrive before being matched to a booking. */
export const payment = pgTable(
  "payment",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    bookingId: uuid("booking_id").references(() => booking.id),
    kind: paymentKind("kind").notNull(),
    method: paymentMethod("method").notNull(),
    status: paymentStatus("status").notNull().default("pending"),
    amountCents: integer("amount_cents").notNull(),
    currency: text("currency").notNull().default("aud"),
    stripePaymentIntentId: text("stripe_payment_intent_id"),
    stripeChargeId: text("stripe_charge_id"),
    stripeRefundId: text("stripe_refund_id"),
    xeroPaymentId: text("xero_payment_id"),
    note: text("note"),
    metadata: jsonb("metadata")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("payment_amount_positive", sql`${t.amountCents} > 0`),
    index("payment_booking_idx").on(t.bookingId),
    uniqueIndex("payment_stripe_pi_uidx").on(t.stripePaymentIntentId, t.kind),
  ],
);

/* -------------------------------------------------------------------------- */
/* Messaging, integrations, platform                                          */
/* -------------------------------------------------------------------------- */

export const messageLog = pgTable(
  "message_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    bookingId: uuid("booking_id").references(() => booking.id),
    clientId: uuid("client_id").references(() => client.id),
    channel: messageChannel("channel").notNull(),
    template: text("template").notNull(),
    /** Recipient address or number at send time. */
    toAddress: text("to_address").notNull(),
    providerMessageId: text("provider_message_id"),
    status: messageStatus("status").notNull().default("queued"),
    error: text("error"),
    /** Idempotency: one message per (booking, template, channel) unless the key differs. */
    dedupeKey: text("dedupe_key"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    sentAt: timestamp("sent_at", { withTimezone: true }),
  },
  (t) => [
    index("message_log_booking_idx").on(t.bookingId),
    uniqueIndex("message_log_dedupe_uidx").on(t.dedupeKey),
  ],
);

export const integrationAccount = pgTable(
  "integration_account",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    businessId: uuid("business_id").references(() => business.id),
    provider: integrationProvider("provider").notNull(),
    /** Xero tenant id, Google calendar id, Stripe account id... */
    externalAccountId: text("external_account_id"),
    /** AES-256-GCM encrypted JSON (see src/server/crypto.ts). Never store tokens in plaintext. */
    encryptedTokens: text("encrypted_tokens"),
    status: integrationStatus("status").notNull().default("disconnected"),
    lastSyncAt: timestamp("last_sync_at", { withTimezone: true }),
    lastError: text("last_error"),
    /** Provider cursor state: Google syncToken and watch channel, Xero org settings, etc. */
    syncState: jsonb("sync_state")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("integration_account_provider_uidx").on(t.businessId, t.provider)],
);

export const auditLog = pgTable(
  "audit_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** "owner:<userId>", "mcp", "system", "client". */
    actor: text("actor").notNull(),
    action: text("action").notNull(),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id"),
    data: jsonb("data")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("audit_log_entity_idx").on(t.entityType, t.entityId)],
);

/** Transactional outbox: written in the same transaction as the state change, relayed to the worker. */
export const domainEvent = pgTable(
  "domain_event",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    type: text("type").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    processedAt: timestamp("processed_at", { withTimezone: true }),
  },
  (t) => [index("domain_event_unprocessed_idx").on(t.processedAt)],
);

/** Idempotency for inbound webhooks (Stripe event ids, Google channel messages). */
export const webhookEvent = pgTable(
  "webhook_event",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    provider: text("provider").notNull(),
    eventId: text("event_id").notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
    processedAt: timestamp("processed_at", { withTimezone: true }),
  },
  (t) => [uniqueIndex("webhook_event_uidx").on(t.provider, t.eventId)],
);
