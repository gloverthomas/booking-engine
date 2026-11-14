"use server";

import { ownerAction } from "@/server/admin-foundation/owner-action";
import { settingsInputSchema, updateSettings } from "@/server/admin-foundation/settings-admin";

/** Saves business settings. The policy version is bumped server-side whenever the policy text changes. */
export async function updateSettingsAction(input: unknown) {
  return ownerAction(settingsInputSchema, input, async (parsed, { db, actor }) => {
    const saved = await updateSettings(db, actor, parsed);
    return { policyVersion: saved.policyVersion };
  });
}
