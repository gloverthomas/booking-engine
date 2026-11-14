CREATE EXTENSION IF NOT EXISTS btree_gist;--> statement-breakpoint
CREATE TYPE "public"."booking_status" AS ENUM('pending_payment', 'confirmed', 'completed', 'cancelled_by_client', 'cancelled_by_staff', 'late_cancelled', 'no_show', 'expired');--> statement-breakpoint
CREATE TABLE "booking" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"staff_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"status" "booking_status" DEFAULT 'pending_payment' NOT NULL,
	"during" "tstzrange" NOT NULL,
	"hold_expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "booking_during_not_empty" CHECK (NOT isempty("booking"."during"))
);
--> statement-breakpoint
CREATE TABLE "location" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "staff" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "booking" ADD CONSTRAINT "booking_staff_id_staff_id_fk" FOREIGN KEY ("staff_id") REFERENCES "public"."staff"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking" ADD CONSTRAINT "booking_location_id_location_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."location"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- Double-booking guard: no two slot-holding bookings may overlap for the same staff member.
-- Keep the status list in sync with SLOT_HOLDING_STATUSES in src/db/schema.ts.
ALTER TABLE "booking" ADD CONSTRAINT "no_overlap" EXCLUDE USING gist ("staff_id" WITH =, "during" WITH &&) WHERE ("status" IN ('pending_payment', 'confirmed'));
