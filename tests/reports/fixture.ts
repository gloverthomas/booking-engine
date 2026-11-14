import {
  availabilityRule,
  booking,
  bookingService,
  client,
  location,
  payment,
  service,
  timeBlock,
} from "@/db/schema";
import type { Db } from "@/server/db-types";
import { seedBasics } from "../helpers/factories";

export const TZ = "Australia/Melbourne";
/** "Now" for the fixture: Sat 14 Nov 2026, 12:00 Melbourne time (AEDT, UTC+11). */
export const NOW = new Date("2026-11-14T01:00:00Z");

type BookingStatus = typeof booking.$inferInsert.status;
type PaymentKind = typeof payment.$inferInsert.kind;
type PaymentStatus = typeof payment.$inferInsert.status;

export interface Fixture {
  businessId: string;
  northside: string;
  southside: string;
  staffId: string;
  cutId: string;
  beardId: string;
  clients: { sam: string; alex: string; jo: string; pat: string };
  bookings: Record<string, string>;
}

interface BookingSpec {
  key: string;
  clientId: string;
  locationId: string;
  staffId: string;
  status: BookingStatus;
  start: string;
  end: string;
  totalCents: number;
  depositCents: number;
  services: Array<{ id: string; name: string; priceCents: number; durationMin: number }>;
}

/**
 * A small, hand-checkable business. All local times are Melbourne (AEDT, UTC+11 in November).
 * Expected numbers in the tests were worked out by hand from this table.
 */
export async function seedReportFixture(db: Db): Promise<Fixture> {
  const { biz, loc: northsideRow, stylist, cl } = await seedBasics(db);
  const [southsideRow] = await db
    .insert(location)
    .values({ businessId: biz.id, name: "Southside" })
    .returning();
  // seedBasics created "Sam Client"; add the others.
  const [alex, jo, pat] = await db
    .insert(client)
    .values([
      { businessId: biz.id, firstName: "Alex", lastName: "Brown", email: "alex@example.com" },
      { businessId: biz.id, firstName: "Jo", lastName: "Chen", email: "jo@example.com" },
      { businessId: biz.id, firstName: "Pat", lastName: "Dunn", email: "pat@example.com" },
    ])
    .returning();
  const [cut, beard] = await db
    .insert(service)
    .values([
      { businessId: biz.id, name: "Cut", durationMin: 45, priceCents: 9500 },
      { businessId: biz.id, name: "Beard", durationMin: 20, priceCents: 3000 },
    ])
    .returning();

  const cutLine = { id: cut.id, name: "Cut", priceCents: 9500, durationMin: 45 };
  const beardLine = { id: beard.id, name: "Beard", priceCents: 3000, durationMin: 20 };
  const N = northsideRow.id;
  const S = southsideRow.id;
  const base = { staffId: stylist.id, totalCents: 9500, depositCents: 4750, services: [cutLine] };

  const specs: BookingSpec[] = [
    // Completed Oct 20 (A), rebooked by b1 two weeks later.
    {
      ...base,
      key: "b8",
      clientId: cl.id,
      locationId: N,
      status: "completed",
      start: "2026-10-19T23:00:00Z",
      end: "2026-10-19T23:45:00Z",
    },
    // Tue 3 Nov 10:00 completed (A).
    {
      ...base,
      key: "b1",
      clientId: cl.id,
      locationId: N,
      status: "completed",
      start: "2026-11-02T23:00:00Z",
      end: "2026-11-02T23:45:00Z",
    },
    // Sat 7 Nov 09:00 Southside, Cut + Beard, completed (B).
    {
      ...base,
      key: "b2",
      clientId: alex.id,
      locationId: S,
      status: "completed",
      totalCents: 12500,
      depositCents: 6250,
      services: [cutLine, beardLine],
      start: "2026-11-06T22:00:00Z",
      end: "2026-11-06T23:05:00Z",
    },
    // Mon 9 Nov 16:00 completed, balance never paid (C).
    {
      ...base,
      key: "b9",
      clientId: jo.id,
      locationId: N,
      status: "completed",
      start: "2026-11-09T05:00:00Z",
      end: "2026-11-09T05:45:00Z",
    },
    // Thu 12 Nov 14:00 late cancelled, deposit kept (C).
    {
      ...base,
      key: "b3",
      clientId: jo.id,
      locationId: N,
      status: "late_cancelled",
      start: "2026-11-12T03:00:00Z",
      end: "2026-11-12T03:45:00Z",
    },
    // Fri 13 Nov 11:00 no-show, deposit kept + fee charged (B).
    {
      ...base,
      key: "b4",
      clientId: alex.id,
      locationId: N,
      status: "no_show",
      start: "2026-11-13T00:00:00Z",
      end: "2026-11-13T00:45:00Z",
    },
    // Tue 17 Nov cancelled outside the window, refunded (A).
    {
      ...base,
      key: "b5",
      clientId: cl.id,
      locationId: N,
      status: "cancelled_by_client",
      start: "2026-11-16T23:00:00Z",
      end: "2026-11-16T23:45:00Z",
    },
    // Fri 20 Nov 15:00 confirmed, future (C).
    {
      ...base,
      key: "b7",
      clientId: jo.id,
      locationId: N,
      status: "confirmed",
      start: "2026-11-20T04:00:00Z",
      end: "2026-11-20T04:45:00Z",
    },
    // Tue 24 Nov unpaid hold (B): never counts.
    {
      ...base,
      key: "b10",
      clientId: alex.id,
      locationId: N,
      status: "pending_payment",
      start: "2026-11-23T23:00:00Z",
      end: "2026-11-23T23:45:00Z",
    },
    // Old visit by a lapsed client (D), Aug 5 10:00 AEST.
    {
      ...base,
      key: "b6",
      clientId: pat.id,
      locationId: N,
      status: "completed",
      start: "2026-08-05T00:00:00Z",
      end: "2026-08-05T00:45:00Z",
    },
  ];

  const bookings: Record<string, string> = {};
  for (const spec of specs) {
    const [row] = await db
      .insert(booking)
      .values({
        staffId: spec.staffId,
        locationId: spec.locationId,
        clientId: spec.clientId,
        status: spec.status,
        during: { start: new Date(spec.start), end: new Date(spec.end) },
        totalCents: spec.totalCents,
        depositCents: spec.depositCents,
      })
      .returning();
    bookings[spec.key] = row.id;
    await db.insert(bookingService).values(
      spec.services.map((s, position) => ({
        bookingId: row.id,
        serviceId: s.id,
        name: s.name,
        durationMin: s.durationMin,
        priceCents: s.priceCents,
        position,
      })),
    );
  }

  const pay = (
    key: string,
    kind: PaymentKind,
    amountCents: number,
    createdAt: string,
    status: PaymentStatus = "succeeded",
  ) =>
    db.insert(payment).values({
      bookingId: bookings[key],
      kind,
      method: kind === "balance" ? "cash" : "stripe_online",
      status,
      amountCents,
      createdAt: new Date(createdAt),
    });

  await pay("b8", "deposit", 4750, "2026-10-12T03:00:00Z");
  await pay("b8", "balance", 4750, "2026-10-20T01:00:00Z");
  await pay("b1", "deposit", 4750, "2026-10-30T02:00:00Z");
  await pay("b1", "balance", 4750, "2026-11-03T01:00:00Z");
  // 22:00Z on 2 Nov is 09:00 on 3 Nov in Melbourne: must land on the 3rd, not the 2nd.
  await pay("b2", "deposit", 6250, "2026-11-02T22:00:00Z");
  await pay("b2", "balance", 6250, "2026-11-07T02:00:00Z");
  await pay("b9", "deposit", 4750, "2026-11-04T03:00:00Z");
  await pay("b3", "deposit", 4750, "2026-11-10T03:00:00Z");
  await pay("b4", "deposit", 4750, "2026-11-08T03:00:00Z");
  await pay("b4", "no_show_fee", 1900, "2026-11-14T00:30:00Z");
  await pay("b5", "deposit", 4750, "2026-11-01T03:00:00Z");
  await pay("b5", "refund", 4750, "2026-11-12T03:00:00Z");
  await pay("b7", "deposit", 4750, "2026-11-13T03:00:00Z");
  await pay("b6", "deposit", 4750, "2026-07-20T03:00:00Z");
  await pay("b6", "balance", 4750, "2026-08-05T01:00:00Z");
  // Ignored: still pending, and failed.
  await pay("b10", "deposit", 4750, "2026-11-13T03:00:00Z", "pending");
  await pay("b7", "balance", 4750, "2026-11-13T04:00:00Z", "failed");

  // Hours: Ryan works Mon-Fri 09:00-17:00 at Northside and Sat 09:00-15:00 at Southside.
  await db.insert(availabilityRule).values([
    ...[1, 2, 3, 4, 5].map((weekday) => ({
      staffId: stylist.id,
      locationId: N,
      weekday,
      startMinute: 540,
      endMinute: 1020,
    })),
    { staffId: stylist.id, locationId: S, weekday: 6, startMinute: 540, endMinute: 900 },
  ]);
  // Wed 4 Nov 09:00-13:00 off.
  await db.insert(timeBlock).values({
    staffId: stylist.id,
    during: { start: new Date("2026-11-03T22:00:00Z"), end: new Date("2026-11-04T02:00:00Z") },
    reason: "Dentist",
  });

  return {
    businessId: biz.id,
    northside: N,
    southside: S,
    staffId: stylist.id,
    cutId: cut.id,
    beardId: beard.id,
    clients: { sam: cl.id, alex: alex.id, jo: jo.id, pat: pat.id },
    bookings,
  };
}
