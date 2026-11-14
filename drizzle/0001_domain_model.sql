CREATE TYPE "public"."integration_provider" AS ENUM('google', 'xero', 'stripe');--> statement-breakpoint
CREATE TYPE "public"."integration_status" AS ENUM('connected', 'error', 'disconnected');--> statement-breakpoint
CREATE TYPE "public"."message_channel" AS ENUM('email', 'sms');--> statement-breakpoint
CREATE TYPE "public"."message_status" AS ENUM('queued', 'sent', 'delivered', 'failed');--> statement-breakpoint
CREATE TYPE "public"."payment_kind" AS ENUM('deposit', 'balance', 'no_show_fee', 'late_cancel_fee', 'refund');--> statement-breakpoint
CREATE TYPE "public"."payment_method" AS ENUM('stripe_online', 'stripe_in_person', 'cash', 'eftpos', 'other');--> statement-breakpoint
CREATE TYPE "public"."payment_status" AS ENUM('pending', 'succeeded', 'failed', 'refunded', 'partially_refunded');--> statement-breakpoint
CREATE TYPE "public"."time_block_source" AS ENUM('manual', 'google');--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor" text NOT NULL,
	"action" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "availability_rule" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"staff_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"weekday" integer NOT NULL,
	"start_minute" integer NOT NULL,
	"end_minute" integer NOT NULL,
	"valid_from" text,
	"valid_to" text,
	CONSTRAINT "availability_weekday_range" CHECK ("availability_rule"."weekday" BETWEEN 0 AND 6),
	CONSTRAINT "availability_minutes_range" CHECK ("availability_rule"."start_minute" >= 0 AND "availability_rule"."end_minute" <= 1440 AND "availability_rule"."start_minute" < "availability_rule"."end_minute")
);
--> statement-breakpoint
CREATE TABLE "booking_service" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"booking_id" uuid NOT NULL,
	"service_id" uuid,
	"name" text NOT NULL,
	"duration_min" integer NOT NULL,
	"price_cents" integer NOT NULL,
	"position" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "business" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"timezone" text DEFAULT 'Australia/Melbourne' NOT NULL,
	"abn" text,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "client" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid,
	"first_name" text NOT NULL,
	"last_name" text DEFAULT '' NOT NULL,
	"email" text,
	"phone" text,
	"pronouns" text,
	"notes" text,
	"marketing_opt_in" boolean DEFAULT false NOT NULL,
	"blocked" boolean DEFAULT false NOT NULL,
	"is_vip" boolean DEFAULT false NOT NULL,
	"stripe_customer_id" text,
	"xero_contact_id" text,
	"merged_into_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "domain_event" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "integration_account" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid,
	"provider" "integration_provider" NOT NULL,
	"external_account_id" text,
	"encrypted_tokens" text,
	"status" "integration_status" DEFAULT 'disconnected' NOT NULL,
	"last_sync_at" timestamp with time zone,
	"last_error" text,
	"sync_state" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "message_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"booking_id" uuid,
	"client_id" uuid,
	"channel" "message_channel" NOT NULL,
	"template" text NOT NULL,
	"to_address" text NOT NULL,
	"provider_message_id" text,
	"status" "message_status" DEFAULT 'queued' NOT NULL,
	"error" text,
	"dedupe_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "payment" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"booking_id" uuid,
	"kind" "payment_kind" NOT NULL,
	"method" "payment_method" NOT NULL,
	"status" "payment_status" DEFAULT 'pending' NOT NULL,
	"amount_cents" integer NOT NULL,
	"currency" text DEFAULT 'aud' NOT NULL,
	"stripe_payment_intent_id" text,
	"stripe_charge_id" text,
	"stripe_refund_id" text,
	"xero_payment_id" text,
	"note" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_amount_positive" CHECK ("payment"."amount_cents" > 0)
);
--> statement-breakpoint
CREATE TABLE "service" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid,
	"name" text NOT NULL,
	"description" text,
	"category" text,
	"duration_min" integer NOT NULL,
	"price_cents" integer NOT NULL,
	"buffer_min" integer DEFAULT 0 NOT NULL,
	"deposit_pct" integer,
	"vip_only" boolean DEFAULT false NOT NULL,
	"intake_questions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "service_location" (
	"service_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	CONSTRAINT "service_location_service_id_location_id_pk" PRIMARY KEY("service_id","location_id")
);
--> statement-breakpoint
CREATE TABLE "service_staff" (
	"service_id" uuid NOT NULL,
	"staff_id" uuid NOT NULL,
	"price_cents" integer,
	"duration_min" integer,
	CONSTRAINT "service_staff_service_id_staff_id_pk" PRIMARY KEY("service_id","staff_id")
);
--> statement-breakpoint
CREATE TABLE "time_block" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"staff_id" uuid NOT NULL,
	"during" "tstzrange" NOT NULL,
	"reason" text,
	"source" time_block_source DEFAULT 'manual' NOT NULL,
	"external_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "time_block_during_not_empty" CHECK (NOT isempty("time_block"."during"))
);
--> statement-breakpoint
CREATE TABLE "webhook_event" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" text NOT NULL,
	"event_id" text NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "booking" ADD COLUMN "client_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "booking" ADD COLUMN "total_cents" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "booking" ADD COLUMN "deposit_cents" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "booking" ADD COLUMN "booked_for_other" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "booking" ADD COLUMN "comments" text;--> statement-breakpoint
ALTER TABLE "booking" ADD COLUMN "intake_answers" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "booking" ADD COLUMN "source" text DEFAULT 'online' NOT NULL;--> statement-breakpoint
ALTER TABLE "booking" ADD COLUMN "policy_accepted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "booking" ADD COLUMN "policy_version" text;--> statement-breakpoint
ALTER TABLE "booking" ADD COLUMN "manage_token_hash" text;--> statement-breakpoint
ALTER TABLE "booking" ADD COLUMN "cancelled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "booking" ADD COLUMN "cancel_reason" text;--> statement-breakpoint
ALTER TABLE "booking" ADD COLUMN "gcal_event_id" text;--> statement-breakpoint
ALTER TABLE "booking" ADD COLUMN "xero_invoice_id" text;--> statement-breakpoint
ALTER TABLE "booking" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "location" ADD COLUMN "business_id" uuid;--> statement-breakpoint
ALTER TABLE "location" ADD COLUMN "address_line" text;--> statement-breakpoint
ALTER TABLE "location" ADD COLUMN "suburb" text;--> statement-breakpoint
ALTER TABLE "location" ADD COLUMN "state" text;--> statement-breakpoint
ALTER TABLE "location" ADD COLUMN "postcode" text;--> statement-breakpoint
ALTER TABLE "location" ADD COLUMN "phone" text;--> statement-breakpoint
ALTER TABLE "location" ADD COLUMN "arrival_note" text;--> statement-breakpoint
ALTER TABLE "location" ADD COLUMN "active" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "location" ADD COLUMN "sort_order" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "staff" ADD COLUMN "business_id" uuid;--> statement-breakpoint
ALTER TABLE "staff" ADD COLUMN "email" text;--> statement-breakpoint
ALTER TABLE "staff" ADD COLUMN "level" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "staff" ADD COLUMN "active" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "availability_rule" ADD CONSTRAINT "availability_rule_staff_id_staff_id_fk" FOREIGN KEY ("staff_id") REFERENCES "public"."staff"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "availability_rule" ADD CONSTRAINT "availability_rule_location_id_location_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."location"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking_service" ADD CONSTRAINT "booking_service_booking_id_booking_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."booking"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking_service" ADD CONSTRAINT "booking_service_service_id_service_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."service"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client" ADD CONSTRAINT "client_business_id_business_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."business"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_account" ADD CONSTRAINT "integration_account_business_id_business_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."business"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_log" ADD CONSTRAINT "message_log_booking_id_booking_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."booking"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_log" ADD CONSTRAINT "message_log_client_id_client_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."client"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment" ADD CONSTRAINT "payment_booking_id_booking_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."booking"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service" ADD CONSTRAINT "service_business_id_business_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."business"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_location" ADD CONSTRAINT "service_location_service_id_service_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."service"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_location" ADD CONSTRAINT "service_location_location_id_location_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."location"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_staff" ADD CONSTRAINT "service_staff_service_id_service_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."service"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_staff" ADD CONSTRAINT "service_staff_staff_id_staff_id_fk" FOREIGN KEY ("staff_id") REFERENCES "public"."staff"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "time_block" ADD CONSTRAINT "time_block_staff_id_staff_id_fk" FOREIGN KEY ("staff_id") REFERENCES "public"."staff"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_log_entity_idx" ON "audit_log" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "availability_rule_staff_idx" ON "availability_rule" USING btree ("staff_id");--> statement-breakpoint
CREATE INDEX "booking_service_booking_idx" ON "booking_service" USING btree ("booking_id");--> statement-breakpoint
CREATE INDEX "client_email_idx" ON "client" USING btree ("email");--> statement-breakpoint
CREATE INDEX "client_phone_idx" ON "client" USING btree ("phone");--> statement-breakpoint
CREATE INDEX "domain_event_unprocessed_idx" ON "domain_event" USING btree ("processed_at");--> statement-breakpoint
CREATE UNIQUE INDEX "integration_account_provider_uidx" ON "integration_account" USING btree ("business_id","provider");--> statement-breakpoint
CREATE INDEX "message_log_booking_idx" ON "message_log" USING btree ("booking_id");--> statement-breakpoint
CREATE UNIQUE INDEX "message_log_dedupe_uidx" ON "message_log" USING btree ("dedupe_key");--> statement-breakpoint
CREATE INDEX "payment_booking_idx" ON "payment" USING btree ("booking_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_stripe_pi_uidx" ON "payment" USING btree ("stripe_payment_intent_id","kind");--> statement-breakpoint
CREATE UNIQUE INDEX "time_block_external_uidx" ON "time_block" USING btree ("staff_id","source","external_id");--> statement-breakpoint
CREATE UNIQUE INDEX "webhook_event_uidx" ON "webhook_event" USING btree ("provider","event_id");--> statement-breakpoint
ALTER TABLE "booking" ADD CONSTRAINT "booking_client_id_client_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."client"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "location" ADD CONSTRAINT "location_business_id_business_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."business"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff" ADD CONSTRAINT "staff_business_id_business_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."business"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "booking_client_idx" ON "booking" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "booking_status_idx" ON "booking" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "booking_manage_token_uidx" ON "booking" USING btree ("manage_token_hash");