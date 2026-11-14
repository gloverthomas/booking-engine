import { eq } from "drizzle-orm";
import { z } from "zod";
import { business } from "@/db/schema";
import { recordAudit, type Actor } from "@/server/audit";
import type { Db } from "@/server/db-types";
import { businessSettingsSchema, parseSettings, type BusinessSettings } from "@/server/settings";
import { getBusiness } from "./business";

/**
 * What the settings form may change. policyVersion is deliberately absent: it is bumped by the
 * server whenever the policy text changes, so a client can never forge or reuse a version.
 */
export const settingsInputSchema = businessSettingsSchema
  .omit({ policyVersion: true })
  .extend({ policyText: z.string().max(6000).default("") });

export type SettingsFormInput = z.input<typeof settingsInputSchema>;
export type SettingsInput = z.output<typeof settingsInputSchema>;

/** "1" -> "2". A non-numeric version (hand-edited data) restarts the sequence at "2". */
export function nextPolicyVersion(current: string): string {
  const n = Number.parseInt(current, 10);
  return String(Number.isFinite(n) ? n + 1 : 2);
}

export async function getAdminSettings(
  db: Db,
): Promise<{ businessId: string; timezone: string; settings: BusinessSettings }> {
  const biz = await getBusiness(db);
  return { businessId: biz.id, timezone: biz.timezone, settings: parseSettings(biz.settings) };
}

export async function updateSettings(
  db: Db,
  actor: Actor,
  input: SettingsInput,
): Promise<BusinessSettings> {
  return db.transaction(async (tx) => {
    const biz = await getBusiness(tx);
    const current = parseSettings(biz.settings);
    const policyText = input.policyText.trim();
    const policyChanged = policyText !== current.policyText.trim();
    const next: BusinessSettings = {
      ...current,
      ...input,
      policyText,
      policyVersion: policyChanged
        ? nextPolicyVersion(current.policyVersion)
        : current.policyVersion,
    };

    const changed = (Object.keys(next) as Array<keyof BusinessSettings>).filter(
      (key) => next[key] !== current[key],
    );
    if (changed.length === 0) return current;

    // Merge over the raw JSON so keys this form does not know about are preserved.
    await tx
      .update(business)
      .set({ settings: { ...biz.settings, ...next } })
      .where(eq(business.id, biz.id));
    await recordAudit(tx, {
      actor,
      action: "settings.updated",
      entityType: "business",
      entityId: biz.id,
      data: {
        changed,
        policyVersion: next.policyVersion,
      },
    });
    return next;
  });
}
