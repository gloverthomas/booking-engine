"use server";

import { settingsInputSchema, updateSettings } from "@/server/admin-foundation/settings-admin";
import { accessAction } from "@/server/auth/run-action";

/** Saves business settings. The policy version is bumped server-side whenever the policy text changes. */
export async function updateSettingsAction(input: unknown) {
  return accessAction("settings.edit", settingsInputSchema, input, async (parsed, { db, actor }) => {
    const saved = await updateSettings(db, actor, parsed);
    return { policyVersion: saved.policyVersion };
  });
}
