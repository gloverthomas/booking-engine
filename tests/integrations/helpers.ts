import { randomBytes } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, vi } from "vitest";
import { booking, bookingService, integrationAccount, payment } from "@/db/schema";
import type { Db } from "@/server/db-types";
import { encryptJson } from "@/server/crypto";
import type { IntegrationEnv } from "@/server/integrations/common/env";
import type {
  CalendarEventInput,
  CalendarEventPatch,
  GoogleCalendarEvent,
  GoogleCalendarPort,
  ListEventsParams,
  ListEventsResult,
  WatchRequest,
} from "@/server/integrations/google/port";
import { seedBasics } from "../helpers/factories";
import { createTestDb } from "../helpers/test-db";

export const TEST_KEY = randomBytes(32).toString("base64");

export const testEnv = (overrides: Partial<IntegrationEnv> = {}): IntegrationEnv => ({
  APP_URL: "https://book.example.com",
  ENCRYPTION_KEY: TEST_KEY,
  GOOGLE_CLIENT_ID: "google-client",
  GOOGLE_CLIENT_SECRET: "google-secret",
  XERO_CLIENT_ID: "xero-client",
  XERO_CLIENT_SECRET: "xero-secret",
  ...overrides,
});

export const NOW = new Date("2026-11-14T02:00:00.000Z");
export const fixedNow = (): Date => NOW;
export const silentLog = (): void => {};

export interface BookingSeed {
  bookingId: string;
  staffId: string;
  clientId: string;
  locationId: string;
  businessId: string;
}

/** A confirmed booking, two services, starting 2026-11-20 10:00 Melbourne (23:00Z the day before). */
export async function seedBooking(
  db: Db,
  overrides: Partial<typeof booking.$inferInsert> = {},
): Promise<BookingSeed> {
  const { biz, loc, stylist, cl } = await seedBasics(db);
  const start = new Date("2026-11-19T23:00:00.000Z");
  const end = new Date("2026-11-20T00:15:00.000Z");
  const [row] = await db
    .insert(booking)
    .values({
      staffId: stylist.id,
      locationId: loc.id,
      clientId: cl.id,
      status: "confirmed",
      during: { start, end },
      totalCents: 15000,
      depositCents: 7500,
      ...overrides,
    })
    .returning();
  await db.insert(bookingService).values([
    { bookingId: row.id, name: "Haircut", durationMin: 45, priceCents: 9500, position: 0 },
    { bookingId: row.id, name: "Beard trim", durationMin: 15, priceCents: 5500, position: 1 },
  ]);
  return {
    bookingId: row.id,
    staffId: stylist.id,
    clientId: cl.id,
    locationId: loc.id,
    businessId: biz.id,
  };
}

export async function seedAccount(
  db: Db,
  businessId: string,
  provider: "google" | "xero",
  overrides: Partial<typeof integrationAccount.$inferInsert> = {},
  tokens: unknown = { accessToken: "a", refreshToken: "r", expiryDate: NOW.getTime() + 3_600_000 },
) {
  const [row] = await db
    .insert(integrationAccount)
    .values({
      businessId,
      provider,
      externalAccountId: provider === "google" ? "primary" : "tenant-1",
      encryptedTokens: encryptJson(tokens, TEST_KEY),
      status: "connected",
      syncState: provider === "google" ? { calendarId: "primary" } : {},
      ...overrides,
    })
    .returning();
  return row;
}

export async function seedPayment(
  db: Db,
  bookingId: string,
  overrides: Partial<typeof payment.$inferInsert> = {},
) {
  const [row] = await db
    .insert(payment)
    .values({
      bookingId,
      kind: "deposit",
      method: "stripe_online",
      status: "succeeded",
      amountCents: 7500,
      stripePaymentIntentId: `pi_${randomBytes(4).toString("hex")}`,
      createdAt: new Date("2026-11-14T01:00:00.000Z"),
      ...overrides,
    })
    .returning();
  return row;
}

/** Scriptable in-memory Google Calendar port. */
export interface FakeGoogle extends GoogleCalendarPort {
  calls: Array<{ method: string; args: unknown[] }>;
  events: Map<string, CalendarEventInput & { status?: string }>;
  listResponses: Array<ListEventsResult | Error>;
  listParams: ListEventsParams[];
  insertError?: Error;
  patchError?: Error;
  deleteError?: Error;
  watchError?: Error;
  watches: WatchRequest[];
}

export function fakeGoogle(): FakeGoogle {
  const fake: FakeGoogle = {
    calls: [],
    events: new Map(),
    listResponses: [],
    listParams: [],
    watches: [],
    insertEvent: vi.fn(async (calendarId: string, eventId: string, event: CalendarEventInput) => {
      fake.calls.push({ method: "insert", args: [calendarId, eventId, event] });
      if (fake.insertError) throw fake.insertError;
      fake.events.set(eventId, event);
      return { id: eventId };
    }),
    patchEvent: vi.fn(async (calendarId: string, eventId: string, patch: CalendarEventPatch) => {
      fake.calls.push({ method: "patch", args: [calendarId, eventId, patch] });
      if (fake.patchError) throw fake.patchError;
    }),
    deleteEvent: vi.fn(async (calendarId: string, eventId: string) => {
      fake.calls.push({ method: "delete", args: [calendarId, eventId] });
      if (fake.deleteError) throw fake.deleteError;
      fake.events.delete(eventId);
    }),
    listEvents: vi.fn(async (_calendarId: string, params: ListEventsParams) => {
      fake.listParams.push(params);
      const next = fake.listResponses.shift();
      if (!next) return { events: [], nextSyncToken: "token-default" };
      if (next instanceof Error) throw next;
      return next;
    }),
    watch: vi.fn(async (_calendarId: string, request: WatchRequest) => {
      fake.calls.push({ method: "watch", args: [request] });
      if (fake.watchError) throw fake.watchError;
      fake.watches.push(request);
      return {
        resourceId: `res-${fake.watches.length}`,
        expiration: new Date(NOW.getTime() + request.ttlSeconds * 1000),
      };
    }),
    stopChannel: vi.fn(async (channelId: string, resourceId: string) => {
      fake.calls.push({ method: "stop", args: [channelId, resourceId] });
    }),
  };
  return fake;
}

export const busyEvent = (
  id: string,
  startIso: string,
  endIso: string,
  extra: Partial<GoogleCalendarEvent> = {},
): GoogleCalendarEvent => ({
  id,
  status: "confirmed",
  summary: "Dentist",
  start: { dateTime: startIso },
  end: { dateTime: endIso },
  ...extra,
});

type TestDb = Awaited<ReturnType<typeof createTestDb>>;

const shared: { current?: TestDb; registered: boolean } = { registered: false };

/**
 * One in-process Postgres per test file (migrating a fresh PGlite per test is the slow part),
 * emptied before every test. Safe to call from several suites imported into one test file: the
 * hooks are registered once. Read `.current` inside hooks and tests.
 */
export function setupTestDb(): { readonly current: TestDb } {
  if (!shared.registered) {
    shared.registered = true;
    beforeAll(async () => {
      shared.current = await createTestDb();
    }, 60_000);
    afterAll(async () => {
      await shared.current?.client.close();
    });
    beforeEach(async () => {
      await shared.current!.db.execute(
        sql`truncate table business, webhook_event, domain_event, audit_log, integration_account restart identity cascade`,
      );
    });
  }
  return {
    get current() {
      return shared.current!;
    },
  };
}
