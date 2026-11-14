import { check, pgEnum, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { tstzrange } from "./tstzrange";

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

export const location = pgTable("location", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const staff = pgTable("staff", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

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
    status: bookingStatus("status").notNull().default("pending_payment"),
    during: tstzrange("during").notNull(),
    holdExpiresAt: timestamp("hold_expires_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [check("booking_during_not_empty", sql`NOT isempty(${table.during})`)],
);
