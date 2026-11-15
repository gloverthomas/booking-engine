ALTER TABLE "booking" ADD COLUMN "external_ref" text;--> statement-breakpoint
ALTER TABLE "client" ADD COLUMN "external_ref" text;--> statement-breakpoint
CREATE UNIQUE INDEX "booking_external_ref_uidx" ON "booking" USING btree ("external_ref") WHERE "booking"."external_ref" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "client_external_ref_uidx" ON "client" USING btree ("external_ref") WHERE "client"."external_ref" IS NOT NULL;