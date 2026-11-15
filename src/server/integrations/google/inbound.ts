import { and, asc, eq, notInArray } from "drizzle-orm";
import { integrationAccount, staff, timeBlock } from "@/db/schema";
import type { Db } from "@/server/db-types";
import {
  listAccounts,
  patchSyncState,
  recordSuccess,
  type AccountRow,
  type AccountStaffId,
} from "../common/account-store";
import { AuthRevokedError, ProviderGoneError } from "../common/errors";
import { withAdvisoryLock } from "../common/locks";
import { classifyEvent } from "./event-mapper";
import type { GoogleCalendarEvent } from "./port";
import {
  loadGoogleRuntime,
  parseSyncState,
  reportGoogleFailure,
  type GoogleDeps,
  type GoogleRuntime,
} from "./runtime";

const DAY_MS = 24 * 60 * 60 * 1000;
/** How far ahead a full sync looks. Bookings are capped well inside this. */
export const DEFAULT_WINDOW_DAYS = 180;
/** When fewer than this many days of window remain, the next sync is a full one that rolls it forward. */
export const WINDOW_ROLL_DAYS = 30;
const SYNC_LOCK = "integrations:google:sync";

/** One lock per account, so two stylists' syncs run side by side but never the same one twice. */
const syncLockName = (staffId: AccountStaffId): string =>
  staffId === null ? SYNC_LOCK : `${SYNC_LOCK}:${staffId}`;

export interface SyncOptions {
  forceFull?: boolean;
  windowDays?: number;
  /** Which account to sync: a stylist's own, or (default, null) the business-wide one. */
  staffId?: AccountStaffId;
}

export interface SyncResult {
  mode: "incremental" | "full" | "busy" | "skipped";
  upserted: number;
  deleted: number;
}

/**
 * The stylist whose availability Google busy time blocks. A stylist's own account always blocks
 * that stylist. The business-wide account blocks the configured stylist, else the first active one.
 */
export async function resolveStaffId(
  db: Db,
  account: AccountRow,
  configured: string | undefined,
): Promise<string | null> {
  if (account.staffId) return account.staffId;
  if (configured) return configured;
  const [row] = await db
    .select({ id: staff.id })
    .from(staff)
    .where(eq(staff.active, true))
    .orderBy(asc(staff.createdAt))
    .limit(1);
  return row?.id ?? null;
}

/**
 * True when this stylist has their own connected calendar. The business-wide account then stops
 * importing for them: two accounts writing the same person's blocks would clobber each other on
 * every full sync, and the personal calendar is the one they actually keep.
 */
export async function hasOwnConnectedCalendar(db: Db, staffId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: integrationAccount.id })
    .from(integrationAccount)
    .where(
      and(
        eq(integrationAccount.provider, "google"),
        eq(integrationAccount.staffId, staffId),
        eq(integrationAccount.status, "connected"),
      ),
    )
    .limit(1);
  return Boolean(row);
}

interface Counters {
  upserted: number;
  deleted: number;
  seen: Set<string>;
}

async function applyEvents(
  db: Db,
  staffId: string,
  timezone: string,
  events: GoogleCalendarEvent[],
  counters: Counters,
): Promise<void> {
  for (const event of events) {
    const decision = classifyEvent(event, timezone);
    if (decision.action === "skip") continue;
    if (decision.action === "delete") {
      await db
        .delete(timeBlock)
        .where(
          and(
            eq(timeBlock.staffId, staffId),
            eq(timeBlock.source, "google"),
            eq(timeBlock.externalId, event.id),
          ),
        );
      counters.deleted += 1;
      continue;
    }
    const during = { start: decision.start, end: decision.end };
    await db
      .insert(timeBlock)
      .values({
        staffId,
        during,
        reason: decision.reason,
        source: "google",
        externalId: event.id,
      })
      .onConflictDoUpdate({
        target: [timeBlock.staffId, timeBlock.source, timeBlock.externalId],
        set: { during, reason: decision.reason },
      });
    counters.seen.add(event.id);
    counters.upserted += 1;
  }
}

async function runIncremental(
  db: Db,
  rt: GoogleRuntime,
  staffId: string,
  syncToken: string,
  counters: Counters,
): Promise<string | undefined> {
  let pageToken: string | undefined;
  let nextSyncToken: string | undefined;
  do {
    const page = await rt.port.listEvents(rt.calendarId, { syncToken, pageToken });
    await applyEvents(db, staffId, rt.timezone, page.events, counters);
    pageToken = page.nextPageToken;
    nextSyncToken = page.nextSyncToken ?? nextSyncToken;
  } while (pageToken);
  return nextSyncToken;
}

async function runFull(
  db: Db,
  rt: GoogleRuntime,
  staffId: string,
  window: { timeMin: Date; timeMax: Date },
  counters: Counters,
): Promise<string | undefined> {
  let pageToken: string | undefined;
  let nextSyncToken: string | undefined;
  do {
    const page = await rt.port.listEvents(rt.calendarId, { pageToken, ...window });
    await applyEvents(db, staffId, rt.timezone, page.events, counters);
    pageToken = page.nextPageToken;
    nextSyncToken = page.nextSyncToken ?? nextSyncToken;
  } while (pageToken);

  // Anything we hold that the calendar no longer returns has been removed or moved out of range.
  const stale = and(eq(timeBlock.staffId, staffId), eq(timeBlock.source, "google"));
  const seen = [...counters.seen];
  const removed = await db
    .delete(timeBlock)
    .where(seen.length > 0 ? and(stale, notInArray(timeBlock.externalId, seen)) : stale)
    .returning({ id: timeBlock.id });
  counters.deleted += removed.length;
  return nextSyncToken;
}

function needsFullSync(
  syncToken: string | undefined,
  windowEnd: string | undefined,
  now: Date,
  options: SyncOptions,
): boolean {
  if (options.forceFull || !syncToken || !windowEnd) return true;
  return new Date(windowEnd).getTime() - now.getTime() < WINDOW_ROLL_DAYS * DAY_MS;
}

/**
 * Pull busy time from Google into time_block.
 *
 * Incremental when we hold a syncToken (one cheap call), full otherwise, when the token has
 * expired (410), or when the look-ahead window needs rolling forward. Recurring events are
 * requested expanded (`singleEvents`), so each instance is its own block. Runs under an
 * advisory lock: if a sync is already running, this one returns `busy`.
 */
export async function syncGoogleCalendar(
  deps: GoogleDeps,
  options: SyncOptions = {},
): Promise<SyncResult> {
  const accountStaffId = options.staffId ?? null;
  const rt = await loadGoogleRuntime(deps, accountStaffId);
  if (!rt) return { mode: "skipped", upserted: 0, deleted: 0 };

  try {
    const lock = syncLockName(accountStaffId);
    const outcome = await withAdvisoryLock(deps.db, lock, { wait: false }, async (tx) => {
      const state = parseSyncState(rt.account);
      const staffId = await resolveStaffId(tx, rt.account, state.staffId);
      if (!staffId) {
        deps.log({ event: "google_sync_skipped", reason: "no_active_staff" });
        return { mode: "skipped", upserted: 0, deleted: 0 } satisfies SyncResult;
      }
      if (accountStaffId === null && (await hasOwnConnectedCalendar(tx, staffId))) {
        deps.log({ event: "google_sync_skipped", reason: "staff_has_own_calendar", staffId });
        return { mode: "skipped", upserted: 0, deleted: 0 } satisfies SyncResult;
      }

      const now = deps.now();
      const counters: Counters = { upserted: 0, deleted: 0, seen: new Set() };
      let mode: "incremental" | "full" = "incremental";
      let nextToken: string | undefined;

      if (!needsFullSync(state.syncToken, state.windowEnd, now, options) && state.syncToken) {
        try {
          nextToken = await runIncremental(tx, rt, staffId, state.syncToken, counters);
        } catch (error) {
          if (!(error instanceof ProviderGoneError)) throw error;
          deps.log({ event: "google_sync_token_expired" });
          mode = "full";
        }
      } else {
        mode = "full";
      }

      if (mode === "full") {
        const windowEnd = new Date(
          now.getTime() + (options.windowDays ?? DEFAULT_WINDOW_DAYS) * DAY_MS,
        );
        const fullCounters: Counters = { upserted: 0, deleted: 0, seen: new Set() };
        nextToken = await runFull(
          tx,
          rt,
          staffId,
          { timeMin: new Date(now.getTime() - DAY_MS), timeMax: windowEnd },
          fullCounters,
        );
        counters.upserted = fullCounters.upserted;
        counters.deleted = fullCounters.deleted;
        await patchSyncState(tx, rt.account.id, {
          windowEnd: windowEnd.toISOString(),
          lastFullSyncAt: now.toISOString(),
        });
      }

      if (nextToken) await patchSyncState(tx, rt.account.id, { syncToken: nextToken });
      return { mode, upserted: counters.upserted, deleted: counters.deleted } satisfies SyncResult;
    });

    if (!outcome.acquired) return { mode: "busy", upserted: 0, deleted: 0 };
    await recordSuccess(deps.db, "google", deps.now(), accountStaffId);
    deps.log({ event: "google_sync_done", staffId: accountStaffId, ...outcome.value });
    return outcome.value;
  } catch (error) {
    await reportGoogleFailure(deps, error, accountStaffId);
    if (error instanceof AuthRevokedError) return { mode: "skipped", upserted: 0, deleted: 0 };
    throw error;
  }
}

/**
 * Sync every connected Google account (the business-wide one and each stylist's). One account
 * failing never stops the others; the first failure is rethrown afterwards so the job retries.
 */
export async function syncAllGoogleAccounts(
  deps: GoogleDeps,
  options: Omit<SyncOptions, "staffId"> = {},
): Promise<Array<{ staffId: AccountStaffId; result: SyncResult }>> {
  const outcomes: Array<{ staffId: AccountStaffId; result: SyncResult }> = [];
  let failure: unknown;
  for (const account of await listAccounts(deps.db, "google")) {
    if (account.status !== "connected") continue;
    try {
      const result = await syncGoogleCalendar(deps, { ...options, staffId: account.staffId });
      outcomes.push({ staffId: account.staffId, result });
    } catch (error) {
      failure ??= error;
    }
  }
  if (failure) throw failure;
  return outcomes;
}
