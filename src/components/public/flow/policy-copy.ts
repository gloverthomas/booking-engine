import type { CatalogPolicy } from "@/lib/public-api-types";

/**
 * The policy text the client agrees to. Falls back to a plain-language summary built from the
 * numbers when the owner has not written any text yet, so the checkbox never points at nothing.
 */
export function policyBody(policy: CatalogPolicy): string {
  const text = policy.text.trim();
  if (text) return text;
  const hours = policy.cancelWindowHours;
  return [
    `A ${policy.depositPct}% deposit is taken at booking and deducted from your service.`,
    `Changes and cancellations need ${hours} hours' notice. If you cancel inside ${hours} hours, or don't arrive, your deposit is not refunded.`,
  ].join("\n");
}
