import { z } from "zod";
import { eq } from "drizzle-orm";
import { business } from "@/db/schema";
import type { Db } from "./db-types";

/** Business-wide rules. Stored as JSON on business.settings; every field has a default. */
export const businessSettingsSchema = z.object({
  /** Granularity of bookable start times. */
  slotStepMin: z.number().int().min(5).max(60).default(15),
  /** Share of the total taken at booking, 0-100. Services may override. */
  depositPct: z.number().min(0).max(100).default(50),
  /** Changes/cancellations inside this many hours forfeit the deposit. */
  cancelWindowHours: z.number().int().min(0).default(24),
  /** Extra fee on no-show / late cancel as % of total, charged to the saved card. 0 = keep deposit only. */
  extraFeePct: z.number().min(0).max(100).default(0),
  /** Outside the window: refund the deposit, or leave it as credit. */
  refundOutsideWindow: z.enum(["refund", "credit"]).default("refund"),
  minNoticeMin: z.number().int().min(0).default(120),
  maxAdvanceDays: z.number().int().min(1).default(90),
  /** How long an unpaid booking holds its slot. */
  holdMinutes: z.number().int().min(1).max(60).default(10),
  /** Hours before the start to send the reminder SMS. */
  reminderHoursBefore: z.number().int().min(1).default(24),
  /** Cash discount applied at checkout, 0-100. */
  cashDiscountPct: z.number().min(0).max(100).default(0),
  policyVersion: z.string().default("1"),
  policyText: z.string().default(""),
  /** Show the "choose a stylist" step. Off while there is one stylist. */
  chooseStaff: z.boolean().default(false),
});

export type BusinessSettings = z.infer<typeof businessSettingsSchema>;

export function parseSettings(raw: unknown): BusinessSettings {
  return businessSettingsSchema.parse(raw ?? {});
}

export async function getBusinessSettings(db: Db, businessId: string): Promise<BusinessSettings> {
  const [row] = await db
    .select({ settings: business.settings })
    .from(business)
    .where(eq(business.id, businessId));
  if (!row) throw new Error(`Business not found: ${businessId}`);
  return parseSettings(row.settings);
}
