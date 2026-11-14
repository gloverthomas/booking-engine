import { eq } from "drizzle-orm";
import { booking, bookingService, business, client, location, payment } from "@/db/schema";
import type { Db } from "@/server/db-types";
import {
  createMemoryEmailSender,
  createMemorySmsProvider,
  type MemoryEmailSender,
  type MemorySmsProvider,
} from "@/server/notifications/providers/memory";
import type { NotificationConfig, NotificationDeps } from "@/server/notifications/types";
import { createTestDb } from "../helpers/test-db";
import { seedBasics } from "../helpers/factories";

export const KEY = Buffer.alloc(32, 7).toString("base64");
/** Saturday 14 Nov 2026, 2:15 PM in Melbourne (AEDT, UTC+11). */
export const START = new Date("2026-11-14T03:15:00.000Z");
export const NOW = new Date("2026-11-10T00:00:00.000Z");

export interface Harness {
  db: Db;
  close: () => Promise<void>;
  email: MemoryEmailSender;
  sms: MemorySmsProvider;
  deps: NotificationDeps;
  logs: Array<Record<string, unknown>>;
  ids: { businessId: string; locationId: string; staffId: string; clientId: string };
  /** Mutable clock so tests can move time. */
  setNow: (date: Date) => void;
}

export async function createHarness(
  overrides: { config?: Partial<NotificationConfig> } = {},
): Promise<Harness> {
  const { db, client: pg } = await createTestDb();
  const { biz, loc, stylist, cl } = await seedBasics(db);
  await db
    .update(business)
    .set({
      name: "Ryan Kennedy Hairdressing",
      settings: { policyText: "", cancelWindowHours: 24, reminderHoursBefore: 24 },
    })
    .where(eq(business.id, biz.id));
  await db
    .update(location)
    .set({
      addressLine: "12 Smith St",
      suburb: "Northcote",
      state: "VIC",
      postcode: "3070",
      arrivalNote: "Please arrive 10 minutes early.",
    })
    .where(eq(location.id, loc.id));
  await db
    .update(client)
    .set({ firstName: "Sam", lastName: "Client", phone: "+61410123456" })
    .where(eq(client.id, cl.id));
  await db.update(client).set({ email: "sam@example.com" }).where(eq(client.id, cl.id));

  const email = createMemoryEmailSender();
  const sms = createMemorySmsProvider();
  const logs: Array<Record<string, unknown>> = [];
  let now = NOW;
  const config: NotificationConfig = {
    appUrl: "https://book.example.com",
    encryptionKey: KEY,
    ownerEmails: ["owner@example.com"],
    ...overrides.config,
  };
  const deps: NotificationDeps = {
    email: () => email,
    sms: () => sms,
    config: () => config,
    now: () => now,
    log: (entry) => logs.push(entry),
  };
  return {
    db,
    close: () => pg.close(),
    email,
    sms,
    deps,
    logs,
    ids: { businessId: biz.id, locationId: loc.id, staffId: stylist.id, clientId: cl.id },
    setNow: (date) => {
      now = date;
    },
  };
}

export async function createBooking(
  h: Harness,
  options: {
    status?: (typeof booking.$inferInsert)["status"];
    start?: Date;
    depositPaidCents?: number;
    comments?: string;
  } = {},
): Promise<string> {
  const start = options.start ?? START;
  const [row] = await h.db
    .insert(booking)
    .values({
      staffId: h.ids.staffId,
      locationId: h.ids.locationId,
      clientId: h.ids.clientId,
      status: options.status ?? "confirmed",
      during: { start, end: new Date(start.getTime() + 75 * 60_000) },
      totalCents: 12500,
      depositCents: 6250,
      comments: options.comments,
    })
    .returning();
  await h.db.insert(bookingService).values([
    {
      bookingId: row.id,
      name: "Maintenance Haircut",
      durationMin: 45,
      priceCents: 9500,
      position: 0,
    },
    { bookingId: row.id, name: "Beard Trim", durationMin: 15, priceCents: 3000, position: 1 },
  ]);
  const paid = options.depositPaidCents ?? 6250;
  if (paid > 0) {
    await h.db.insert(payment).values({
      bookingId: row.id,
      kind: "deposit",
      method: "stripe_online",
      status: "succeeded",
      amountCents: paid,
    });
  }
  return row.id;
}
