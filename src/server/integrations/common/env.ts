import { getEnv, type Env } from "@/lib/env";
import { NotConfiguredError } from "./errors";
import type { OAuthProvider } from "./oauth-state";

/**
 * Env access for the integrations. Nothing here runs at import time: keys are only demanded
 * when a feature is actually used, with a message that says what to set.
 */

export type IntegrationEnv = Pick<
  Env,
  | "APP_URL"
  | "ENCRYPTION_KEY"
  | "GOOGLE_CLIENT_ID"
  | "GOOGLE_CLIENT_SECRET"
  | "XERO_CLIENT_ID"
  | "XERO_CLIENT_SECRET"
>;

export const loadIntegrationEnv = (): IntegrationEnv => getEnv();

function need(value: string | undefined, name: string): string {
  if (!value) throw new NotConfiguredError(`${name} is not set`);
  return value;
}

export const requireEncryptionKey = (env: IntegrationEnv): string =>
  need(env.ENCRYPTION_KEY, "ENCRYPTION_KEY");

/** Public base URL without a trailing slash. */
export const requireAppUrl = (env: IntegrationEnv): string =>
  need(env.APP_URL, "APP_URL").replace(/\/+$/, "");

export const isHttps = (url: string): boolean => url.startsWith("https://");

export function redirectUri(env: IntegrationEnv, provider: OAuthProvider): string {
  return `${requireAppUrl(env)}/api/integrations/${provider}/callback`;
}

export function googleCredentials(env: IntegrationEnv): { clientId: string; clientSecret: string } {
  return {
    clientId: need(env.GOOGLE_CLIENT_ID, "GOOGLE_CLIENT_ID"),
    clientSecret: need(env.GOOGLE_CLIENT_SECRET, "GOOGLE_CLIENT_SECRET"),
  };
}

export function xeroCredentials(env: IntegrationEnv): { clientId: string; clientSecret: string } {
  return {
    clientId: need(env.XERO_CLIENT_ID, "XERO_CLIENT_ID"),
    clientSecret: need(env.XERO_CLIENT_SECRET, "XERO_CLIENT_SECRET"),
  };
}
