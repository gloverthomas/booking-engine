import { getDb } from "@/db/client";
import { getEnv } from "@/lib/env";
import { createLogger } from "@/lib/logger";
import type {
  AvailabilityQuery,
  AvailableSlot,
  CancelInput,
  CancelOutcome,
  CreateHoldInput,
  HoldResult,
  PaymentIntentResult,
  PublicBookingSummary,
  RescheduleInput,
} from "@/server/contracts";
import { verifyManageToken } from "@/server/manage-token";
import { getAvailableSlots } from "@/server/availability";
import {
  cancelBooking,
  confirmBooking,
  createHold,
  getBookingByToken,
  rescheduleBooking,
} from "@/server/booking";
import { createDepositIntent } from "@/server/payments";
import {
  loadBookingContext,
  loadBusiness,
  loadCatalog,
  type BookingContext,
  type BusinessContext,
} from "./public-api-catalog";
import type { RequestLog } from "./public-api-http";
import { createPublicLimiters, type PublicLimiters } from "./public-api-rate-limit";
import type { CatalogData } from "./public-api-types";
import { verifyTurnstile, type TurnstileResult } from "./turnstile";

/** The backend functions the public API needs, with the database already bound. */
export interface PublicBackend {
  getAvailableSlots(query: AvailabilityQuery): Promise<AvailableSlot[]>;
  createHold(input: CreateHoldInput): Promise<HoldResult>;
  confirmBooking(bookingId: string, now?: Date): Promise<void>;
  createDepositIntent(bookingId: string): Promise<PaymentIntentResult>;
  getBookingByToken(token: string): Promise<PublicBookingSummary | null>;
  cancelBooking(input: CancelInput): Promise<CancelOutcome>;
  rescheduleBooking(input: RescheduleInput): Promise<void>;
}

/** Everything a route handler touches. Tests pass fakes; production gets `getPublicApiDeps()`. */
export interface PublicApiDeps {
  backend: PublicBackend;
  loadBusiness(): Promise<BusinessContext>;
  loadCatalog(ctx: BusinessContext, now: Date): Promise<CatalogData>;
  loadBookingContext(bookingId: string): Promise<BookingContext | null>;
  verifyTurnstile(token: string | undefined, ip: string): Promise<TurnstileResult>;
  /** Returns the booking id for an authentic manage token, otherwise null. */
  verifyManageToken(token: string): string | null;
  limiters: PublicLimiters;
  now(): Date;
  log: RequestLog;
  /** Trusted reverse proxies in front of the app (for reading X-Forwarded-For). */
  trustedProxyHops: number;
}

const log = createLogger("public-api");

/** Survives dev hot reloads so rate-limit counters are not reset on every edit. */
const globalForLimiters = globalThis as unknown as { __rkPublicLimiters?: PublicLimiters };

function getLimiters(): PublicLimiters {
  globalForLimiters.__rkPublicLimiters ??= createPublicLimiters();
  return globalForLimiters.__rkPublicLimiters;
}

/** Real dependencies. Built per request (cheap); env is read lazily so import never throws. */
export function getPublicApiDeps(): PublicApiDeps {
  const db = getDb();
  return {
    backend: {
      getAvailableSlots: (query) => getAvailableSlots(db, query),
      createHold: (input) => createHold(db, input),
      confirmBooking: (bookingId, now) => confirmBooking(db, bookingId, now),
      createDepositIntent: (bookingId) => createDepositIntent(db, bookingId),
      getBookingByToken: (token) => getBookingByToken(db, token),
      cancelBooking: (input) => cancelBooking(db, input),
      rescheduleBooking: (input) => rescheduleBooking(db, input),
    },
    loadBusiness: () => loadBusiness(db),
    loadCatalog: (ctx, now) => loadCatalog(db, ctx, now),
    loadBookingContext: (bookingId) => loadBookingContext(db, bookingId),
    verifyTurnstile: (token, ip) => {
      const env = getEnv();
      return verifyTurnstile({
        token,
        remoteIp: ip,
        secret: env.TURNSTILE_SECRET_KEY,
        nodeEnv: env.NODE_ENV,
      });
    },
    verifyManageToken: (token) => {
      const key = getEnv().ENCRYPTION_KEY;
      if (!key) throw new Error("ENCRYPTION_KEY is required to verify manage-booking links");
      return verifyManageToken(token, key);
    },
    limiters: getLimiters(),
    now: () => new Date(),
    log,
    trustedProxyHops: Number(process.env.PUBLIC_TRUSTED_PROXY_HOPS ?? "1") || 1,
  };
}
