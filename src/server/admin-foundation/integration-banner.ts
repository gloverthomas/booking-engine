export interface IntegrationBanner {
  provider: "google" | "xero";
  tone: "success" | "danger";
  text: string;
}

const NAMES = { google: "Google Calendar", xero: "Xero" } as const;
const MAX_MESSAGE = 200;

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Turns the redirect query from the OAuth callbacks (`?integration=google&status=connected`) into a
 * banner. Only known providers and statuses are accepted; the optional message is length-capped.
 */
export function parseIntegrationBanner(params: {
  integration?: string | string[];
  status?: string | string[];
  message?: string | string[];
}): IntegrationBanner | null {
  const provider = first(params.integration);
  const status = first(params.status);
  if (provider !== "google" && provider !== "xero") return null;
  const name = NAMES[provider];
  if (status === "connected") {
    return { provider, tone: "success", text: `${name} is connected.` };
  }
  if (status === "error") {
    const detail = first(params.message)?.trim().slice(0, MAX_MESSAGE);
    return {
      provider,
      tone: "danger",
      text: `Could not connect ${name}.${detail ? ` ${detail}` : ""}`,
    };
  }
  return null;
}
