import { vi } from "vitest";
import type { PublicApiDeps, PublicBackend } from "@/lib/public-api-deps";
import { createPublicLimiters } from "@/lib/public-api-rate-limit";
import type { CatalogData, CatalogStaff } from "@/lib/public-api-types";
import { parseSettings } from "@/server/settings";

export const LOC = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
export const SVC_CUT = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
export const SVC_BEARD = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
export const STAFF_ALEX = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
export const STAFF_BEA = "ffffffff-ffff-4fff-8fff-ffffffffffff";
export const BOOKING_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
export const TOKEN = `${BOOKING_ID}.sig`;
export const NOW = new Date("2026-11-14T00:00:00Z");

export const catalog: CatalogData = {
  business: { name: "Ryan Kennedy Hairdressing", timezone: "Australia/Melbourne" },
  today: "2026-11-14",
  maxAdvanceDays: 90,
  holdMinutes: 10,
  chooseStaff: false,
  waitlistEnabled: true,
  policy: {
    version: "1",
    text: "24 hours notice.",
    cancelWindowHours: 24,
    depositPct: 50,
    refundOutsideWindow: "refund",
  },
  locations: [
    {
      id: LOC,
      name: "Northside",
      addressLine: "302 Rathdowne Street",
      suburb: "Carlton North",
      state: "VIC",
      postcode: "3054",
      arrivalNote: "Arrive 5 minutes early",
      services: [
        {
          id: SVC_CUT,
          name: "Maintenance Haircut",
          description: null,
          category: "Hair",
          durationMin: 45,
          priceCents: 9500,
          depositPct: 50,
          intakeQuestions: [{ id: "q1", label: "Hair length?", required: true }],
        },
        {
          id: SVC_BEARD,
          name: "Beard Trim",
          description: null,
          category: "Beard",
          durationMin: 15,
          priceCents: 3000,
          depositPct: 50,
          intakeQuestions: [{ id: "q2", label: "Allergies?", required: false }],
        },
      ],
      staff: [],
    },
  ],
};

/** The same catalog with stylists on: Alex at the service price, Bea cheaper but slower on a cut. */
const stylists: CatalogStaff[] = [
      {
        id: STAFF_ALEX,
        name: "Alex",
        offers: {
          [SVC_CUT]: { priceCents: 9500, durationMin: 45 },
          [SVC_BEARD]: { priceCents: 3000, durationMin: 15 },
        },
      },
      { id: STAFF_BEA, name: "Bea", offers: { [SVC_CUT]: { priceCents: 7500, durationMin: 60 } } },
];

export const staffCatalog: CatalogData = {
  ...catalog,
  chooseStaff: true,
  locations: catalog.locations.map((loc) => ({ ...loc, staff: stylists })),
};

export function makeBackend(overrides: Partial<PublicBackend> = {}): PublicBackend {
  return {
    getAvailableSlots: vi.fn(async () => []),
    createHold: vi.fn(async () => ({
      bookingId: BOOKING_ID,
      manageToken: TOKEN,
      holdExpiresAt: new Date("2026-11-14T00:10:00Z"),
      totalCents: 9500,
      depositCents: 4750,
      during: {
        start: new Date("2026-11-20T03:30:00Z"),
        end: new Date("2026-11-20T04:15:00Z"),
      },
    })),
    confirmBooking: vi.fn(async () => undefined),
    createDepositIntent: vi.fn(async () => ({
      paymentId: "pay_1",
      clientSecret: "pi_secret",
      amountCents: 4750,
    })),
    getBookingByToken: vi.fn(async () => ({
      bookingId: BOOKING_ID,
      status: "confirmed",
      start: new Date("2026-11-20T03:30:00Z"),
      end: new Date("2026-11-20T04:15:00Z"),
      locationName: "Northside",
      services: [{ name: "Maintenance Haircut", priceCents: 9500 }],
      totalCents: 9500,
      depositCents: 4750,
    })),
    cancelBooking: vi.fn(async () => ({
      bookingId: BOOKING_ID,
      status: "cancelled_by_client" as const,
      depositAction: "refund" as const,
      feeCents: 0,
    })),
    rescheduleBooking: vi.fn(async () => undefined),
    ...overrides,
  };
}

export function makeDeps(overrides: Partial<PublicApiDeps> = {}): PublicApiDeps {
  return {
    backend: makeBackend(),
    loadBusiness: async () => ({
      id: "biz",
      name: "Ryan Kennedy Hairdressing",
      timezone: "Australia/Melbourne",
      settings: parseSettings({ policyVersion: "1", policyText: "24 hours notice." }),
    }),
    loadCatalog: async () => catalog,
    loadBookingContext: async () => ({
      locationId: LOC,
      locationName: "Northside",
      address: "302 Rathdowne Street, Carlton North VIC 3054",
      arrivalNote: "Arrive 5 minutes early",
      phone: "03 9000 0000",
      serviceIds: [SVC_CUT],
      staffId: STAFF_ALEX,
      staffName: "Alex",
      staffRequested: false,
    }),
    verifyTurnstile: async () => ({ ok: true }),
    verifyManageToken: (token) => (token === TOKEN ? BOOKING_ID : null),
    limiters: createPublicLimiters(() => NOW.getTime()),
    now: () => NOW,
    log: vi.fn(),
    trustedProxyHops: 1,
    ...overrides,
  };
}

export const validHoldBody = {
  locationId: LOC,
  serviceIds: [SVC_CUT],
  start: "2026-11-20T03:30:00.000Z",
  client: {
    firstName: "Sam",
    lastName: "Client",
    email: "sam@example.com",
    phone: "0410123456",
    pronouns: "he/him",
    marketingOptIn: false,
  },
  otherPhone: "0391234567",
  company: "Acme",
  bookedForOther: false,
  comments: "Running late maybe",
  intakeAnswers: { q1: "Short", stray: "ignored", q2: "" },
  policyVersion: "1",
  policyAccepted: true,
  turnstileToken: "tok",
};

export function post(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request("http://localhost/api", {
    method: "POST",
    body: typeof body === "string" ? body : JSON.stringify(body),
    headers: { "x-forwarded-for": "1.2.3.4", ...headers },
  });
}

export function get(url: string): Request {
  return new Request(url, { headers: { "x-forwarded-for": "1.2.3.4" } });
}
