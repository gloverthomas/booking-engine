/**
 * The legal operator of the site. Read from the environment so the real details never live in code.
 * While any are missing the pages show a clear "to be confirmed" marker and the site is set to noindex.
 */
export interface Entity {
  legalName: string;
  abn: string;
  tradingName: string;
  address: string;
}

export const TBC = "to be confirmed";

export function readEntity(env: Record<string, string | undefined> = process.env): Entity {
  const pick = (key: string) => env[key]?.trim() || TBC;
  return {
    legalName: pick("ENTITY_LEGAL_NAME"),
    abn: pick("ENTITY_ABN"),
    tradingName: pick("ENTITY_TRADING_NAME"),
    address: pick("ENTITY_ADDRESS"),
  };
}

export function entityConfigured(entity: Entity): boolean {
  return Object.values(entity).every((value) => value !== TBC);
}

export const SITE = {
  name: "HairMate",
  url: process.env.SITE_URL ?? "https://hairmate.shop",
  appUrl: process.env.APP_URL ?? "https://app.hairmate.shop",
  supportEmail: "hello@hairmate.shop",
  privacyEmail: "privacy@hairmate.shop",
} as const;

/** Date shown on the legal pages. Bump when the wording changes. */
export const LEGAL_UPDATED = "15 November 2026";
