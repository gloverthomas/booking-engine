import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import {
  listAccounts,
  patchSyncState,
  type AccountRow,
  type AccountStaffId,
} from "../common/account-store";
import { isHttps, requireAppUrl, requireEncryptionKey } from "../common/env";
import { AuthRevokedError } from "../common/errors";
import { claimOnce, markProcessed } from "../common/once";
import { loadGoogleRuntime, parseSyncState, reportGoogleFailure, type GoogleDeps } from "./runtime";

/** Google caps push channel lifetime at about a week. Ask for the maximum, renew early. */
export const CHANNEL_TTL_SECONDS = 7 * 24 * 60 * 60;
/** Renew when less than this is left, so a missed run still leaves a day of slack. */
export const RENEW_BEFORE_MS = 48 * 60 * 60 * 1000;

export const WEBHOOK_PATH = "/api/integrations/google/webhook";

/**
 * The secret Google echoes back in X-Goog-Channel-Token. Derived from ENCRYPTION_KEY and the
 * channel id, so it needs no storage and each channel has its own.
 */
export function deriveChannelToken(key: string, channelId: string): string {
  return createHmac("sha256", Buffer.from(key, "base64"))
    .update(`google-channel:${channelId}`)
    .digest("hex");
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export interface EnsureChannelResult {
  action: "created" | "renewed" | "unchanged" | "skipped";
}

/**
 * Create the push channel, or replace it when it is missing or close to expiry. The new channel
 * is registered before the old one is stopped, so notifications are never missed.
 */
export async function ensureWatchChannel(
  deps: GoogleDeps,
  options: { force?: boolean; staffId?: AccountStaffId } = {},
): Promise<EnsureChannelResult> {
  const staffId = options.staffId ?? null;
  const rt = await loadGoogleRuntime(deps, staffId);
  if (!rt) return { action: "skipped" };

  const appUrl = requireAppUrl(deps.env);
  if (!isHttps(appUrl)) {
    // Google only delivers to HTTPS endpoints. The 15-minute poll still keeps us in sync.
    deps.log({ event: "google_watch_skipped", reason: "app_url_not_https" });
    return { action: "skipped" };
  }

  const state = parseSyncState(rt.account);
  const now = deps.now();
  const existing = state.channel;
  const expiresAt = existing ? new Date(existing.expiration).getTime() : 0;
  if (!options.force && existing && expiresAt - now.getTime() > RENEW_BEFORE_MS) {
    return { action: "unchanged" };
  }

  try {
    const channelId = randomUUID();
    const result = await rt.port.watch(rt.calendarId, {
      channelId,
      address: `${appUrl}${WEBHOOK_PATH}`,
      token: deriveChannelToken(rt.key, channelId),
      ttlSeconds: CHANNEL_TTL_SECONDS,
    });
    await patchSyncState(deps.db, rt.account.id, {
      channel: {
        id: channelId,
        resourceId: result.resourceId,
        expiration: result.expiration.toISOString(),
      },
    });
    if (existing) {
      try {
        await rt.port.stopChannel(existing.id, existing.resourceId);
      } catch (error) {
        // The old channel expires on its own within days; not worth failing the renewal.
        deps.log({ event: "google_channel_stop_failed", message: String(error) });
      }
    }
    return { action: existing ? "renewed" : "created" };
  } catch (error) {
    await reportGoogleFailure(deps, error, staffId);
    if (error instanceof AuthRevokedError) return { action: "skipped" };
    throw error;
  }
}

/** Stop one account's push channel (used on disconnect). Never throws. */
export async function stopWatchChannel(
  deps: GoogleDeps,
  staffId: AccountStaffId = null,
): Promise<void> {
  const rt = await loadGoogleRuntime(deps, staffId);
  const channel = rt ? parseSyncState(rt.account).channel : undefined;
  if (!rt || !channel) return;
  try {
    await rt.port.stopChannel(channel.id, channel.resourceId);
  } catch (error) {
    deps.log({ event: "google_channel_stop_failed", message: String(error) });
  }
}

/* -------------------------------------------------------------------------- */
/* Webhook                                                                    */
/* -------------------------------------------------------------------------- */

export interface WebhookDeps extends GoogleDeps {
  /**
   * Starts a sync of the account the push belongs to, without making Google wait for it
   * (Next's `after`, or a queue send).
   */
  kickSync: (account: AccountRow) => void;
}

export interface WebhookHeaders {
  channelId: string | null;
  channelToken: string | null;
  resourceState: string | null;
  messageNumber: string | null;
}

export function readWebhookHeaders(headers: Headers): WebhookHeaders {
  return {
    channelId: headers.get("x-goog-channel-id"),
    channelToken: headers.get("x-goog-channel-token"),
    resourceState: headers.get("x-goog-resource-state"),
    messageNumber: headers.get("x-goog-message-number"),
  };
}

export type WebhookOutcome =
  | { status: 200; result: "sync_ack" | "duplicate" | "sync_started" }
  | { status: 400 | 403 | 404; result: "bad_request" | "forbidden" | "unknown_channel" };

/**
 * Validate a push notification and, when genuine, start a sync. Google sends no payload: the
 * headers are all there is. The token check is what stops anyone else from poking this URL.
 */
export async function handleGoogleWebhook(
  deps: WebhookDeps,
  headers: WebhookHeaders,
): Promise<WebhookOutcome> {
  if (!headers.channelId || !headers.channelToken || !headers.resourceState) {
    return { status: 400, result: "bad_request" };
  }
  // Each account (business-wide or a stylist's) has its own channel id.
  const account = (await listAccounts(deps.db, "google")).find(
    (row) => parseSyncState(row).channel?.id === headers.channelId,
  );
  if (!account || account.status !== "connected") {
    return { status: 404, result: "unknown_channel" };
  }
  const key = requireEncryptionKey(deps.env);
  if (!safeEqual(headers.channelToken, deriveChannelToken(key, headers.channelId))) {
    return { status: 403, result: "forbidden" };
  }
  // "sync" is the handshake sent right after the channel is created.
  if (headers.resourceState === "sync") return { status: 200, result: "sync_ack" };

  const dedupeId = `${headers.channelId}:${headers.messageNumber ?? deps.now().getTime()}`;
  if (!(await claimOnce(deps.db, "google", dedupeId))) return { status: 200, result: "duplicate" };
  deps.kickSync(account);
  await markProcessed(deps.db, "google", dedupeId, deps.now());
  return { status: 200, result: "sync_started" };
}
