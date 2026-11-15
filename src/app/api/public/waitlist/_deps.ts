import { getDb } from "@/db/client";
import { getEnv } from "@/lib/env";
import { createLogger } from "@/lib/logger";
import { verifyTurnstile } from "@/lib/turnstile";
import { confirmBooking } from "@/server/booking";
import { createDepositIntent } from "@/server/payments";
import {
  createWaitlistLimiters,
  type WaitlistApiDeps,
  type WaitlistLimiters,
} from "@/server/waitlist/api";

const log = createLogger("public-waitlist");

/** Survives dev hot reloads so rate-limit counters are not reset on every edit. */
const globalForLimiters = globalThis as unknown as { __rkWaitlistLimiters?: WaitlistLimiters };

/** Real dependencies, built per request. Env is read lazily so importing never throws. */
export function getWaitlistApiDeps(): WaitlistApiDeps {
  const db = getDb();
  globalForLimiters.__rkWaitlistLimiters ??= createWaitlistLimiters();
  return {
    db,
    now: () => new Date(),
    log,
    limiters: globalForLimiters.__rkWaitlistLimiters,
    trustedProxyHops: Number(process.env.PUBLIC_TRUSTED_PROXY_HOPS ?? "1") || 1,
    verifyTurnstile: (token, ip) => {
      const env = getEnv();
      return verifyTurnstile({
        token,
        remoteIp: ip,
        secret: env.TURNSTILE_SECRET_KEY,
        nodeEnv: env.NODE_ENV,
      });
    },
    tokenOptions: () => ({ encryptionKey: getEnv().ENCRYPTION_KEY }),
    createDepositIntent: (bookingId) => createDepositIntent(db, bookingId),
    confirmBooking: (bookingId, now) => confirmBooking(db, bookingId, now),
  };
}
