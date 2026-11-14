CREATE TYPE "public"."roster_exception_kind" AS ENUM('off', 'custom');--> statement-breakpoint
CREATE TYPE "public"."staff_role" AS ENUM('owner', 'manager', 'stylist', 'reception');--> statement-breakpoint
CREATE TYPE "public"."target_metric" AS ENUM('revenue', 'bookings', 'rebook_rate', 'utilisation');--> statement-breakpoint
CREATE TYPE "public"."target_period" AS ENUM('week', 'month');--> statement-breakpoint
CREATE TYPE "public"."time_entry_source" AS ENUM('clock', 'manual');--> statement-breakpoint
CREATE TYPE "public"."waitlist_offer_status" AS ENUM('sent', 'claimed', 'expired', 'slot_taken', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."waitlist_status" AS ENUM('waiting', 'offered', 'booked', 'expired', 'cancelled');--> statement-breakpoint
CREATE TABLE "roster_exception" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"staff_id" uuid NOT NULL,
	"location_id" uuid,
	"date" text NOT NULL,
	"kind" "roster_exception_kind" NOT NULL,
	"start_minute" integer,
	"end_minute" integer,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "roster_exception_custom_hours" CHECK ("roster_exception"."kind" = 'off' OR ("roster_exception"."start_minute" IS NOT NULL AND "roster_exception"."end_minute" IS NOT NULL AND "roster_exception"."start_minute" >= 0 AND "roster_exception"."end_minute" <= 1440 AND "roster_exception"."start_minute" < "roster_exception"."end_minute"))
);
--> statement-breakpoint
CREATE TABLE "service_level_price" (
	"service_id" uuid NOT NULL,
	"level" integer NOT NULL,
	"price_cents" integer,
	"duration_min" integer,
	CONSTRAINT "service_level_price_service_id_level_pk" PRIMARY KEY("service_id","level")
);
--> statement-breakpoint
CREATE TABLE "staff_target" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"staff_id" uuid,
	"metric" "target_metric" NOT NULL,
	"period" "target_period" NOT NULL,
	"target_value" integer NOT NULL,
	"valid_from" text NOT NULL,
	"valid_to" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "staff_target_positive" CHECK ("staff_target"."target_value" > 0)
);
--> statement-breakpoint
CREATE TABLE "time_entry" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"staff_id" uuid NOT NULL,
	"location_id" uuid,
	"clock_in" timestamp with time zone NOT NULL,
	"clock_out" timestamp with time zone,
	"break_minutes" integer DEFAULT 0 NOT NULL,
	"source" time_entry_source DEFAULT 'clock' NOT NULL,
	"note" text,
	"approved_at" timestamp with time zone,
	"approved_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "time_entry_order" CHECK ("time_entry"."clock_out" IS NULL OR "time_entry"."clock_out" > "time_entry"."clock_in")
);
--> statement-breakpoint
CREATE TABLE "waitlist_entry" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"staff_id" uuid,
	"service_ids" jsonb NOT NULL,
	"earliest_date" text NOT NULL,
	"latest_date" text NOT NULL,
	"weekdays" jsonb,
	"from_minute" integer,
	"to_minute" integer,
	"status" "waitlist_status" DEFAULT 'waiting' NOT NULL,
	"booked_booking_id" uuid,
	"notes" text,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "waitlist_offer" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"entry_id" uuid NOT NULL,
	"staff_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"during" "tstzrange" NOT NULL,
	"status" "waitlist_offer_status" DEFAULT 'sent' NOT NULL,
	"offered_by" text DEFAULT 'auto' NOT NULL,
	"sent_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"claimed_booking_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "waitlist_offer_during_not_empty" CHECK (NOT isempty("waitlist_offer"."during"))
);
--> statement-breakpoint
DROP INDEX "integration_account_provider_uidx";--> statement-breakpoint
ALTER TABLE "booking" ADD COLUMN "staff_requested" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "integration_account" ADD COLUMN "staff_id" uuid;--> statement-breakpoint
ALTER TABLE "staff" ADD COLUMN "role" "staff_role" DEFAULT 'stylist' NOT NULL;--> statement-breakpoint
ALTER TABLE "staff" ADD COLUMN "user_id" text;--> statement-breakpoint
ALTER TABLE "staff" ADD COLUMN "phone" text;--> statement-breakpoint
ALTER TABLE "staff" ADD COLUMN "colour" text;--> statement-breakpoint
ALTER TABLE "staff" ADD COLUMN "pin_hash" text;--> statement-breakpoint
ALTER TABLE "roster_exception" ADD CONSTRAINT "roster_exception_staff_id_staff_id_fk" FOREIGN KEY ("staff_id") REFERENCES "public"."staff"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "roster_exception" ADD CONSTRAINT "roster_exception_location_id_location_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."location"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_level_price" ADD CONSTRAINT "service_level_price_service_id_service_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."service"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_target" ADD CONSTRAINT "staff_target_staff_id_staff_id_fk" FOREIGN KEY ("staff_id") REFERENCES "public"."staff"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "time_entry" ADD CONSTRAINT "time_entry_staff_id_staff_id_fk" FOREIGN KEY ("staff_id") REFERENCES "public"."staff"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "time_entry" ADD CONSTRAINT "time_entry_location_id_location_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."location"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "waitlist_entry" ADD CONSTRAINT "waitlist_entry_client_id_client_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."client"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "waitlist_entry" ADD CONSTRAINT "waitlist_entry_location_id_location_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."location"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "waitlist_entry" ADD CONSTRAINT "waitlist_entry_staff_id_staff_id_fk" FOREIGN KEY ("staff_id") REFERENCES "public"."staff"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "waitlist_offer" ADD CONSTRAINT "waitlist_offer_entry_id_waitlist_entry_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."waitlist_entry"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "waitlist_offer" ADD CONSTRAINT "waitlist_offer_staff_id_staff_id_fk" FOREIGN KEY ("staff_id") REFERENCES "public"."staff"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "waitlist_offer" ADD CONSTRAINT "waitlist_offer_location_id_location_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."location"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "roster_exception_staff_date_idx" ON "roster_exception" USING btree ("staff_id","date");--> statement-breakpoint
CREATE UNIQUE INDEX "time_entry_one_open_uidx" ON "time_entry" USING btree ("staff_id") WHERE "time_entry"."clock_out" IS NULL;--> statement-breakpoint
CREATE INDEX "time_entry_staff_in_idx" ON "time_entry" USING btree ("staff_id","clock_in");--> statement-breakpoint
CREATE INDEX "waitlist_entry_status_idx" ON "waitlist_entry" USING btree ("status");--> statement-breakpoint
CREATE INDEX "waitlist_entry_client_idx" ON "waitlist_entry" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "waitlist_offer_entry_idx" ON "waitlist_offer" USING btree ("entry_id");--> statement-breakpoint
CREATE INDEX "waitlist_offer_status_idx" ON "waitlist_offer" USING btree ("status");--> statement-breakpoint
ALTER TABLE "integration_account" ADD CONSTRAINT "integration_account_staff_id_staff_id_fk" FOREIGN KEY ("staff_id") REFERENCES "public"."staff"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "integration_account_business_provider_uidx" ON "integration_account" USING btree ("business_id","provider") WHERE "integration_account"."staff_id" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "integration_account_staff_provider_uidx" ON "integration_account" USING btree ("staff_id","provider") WHERE "integration_account"."staff_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "staff" ADD CONSTRAINT "staff_user_id_unique" UNIQUE("user_id");--> statement-breakpoint
-- The business started with exactly one stylist, the owner. Make that explicit.
UPDATE "staff" SET "role" = 'owner' WHERE (SELECT count(*) FROM "staff") = 1;
