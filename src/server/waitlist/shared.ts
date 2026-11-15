import { sql, type SQL } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import type { waitlistEntry, waitlistOffer } from "@/db/schema";
import { getEnv } from "@/lib/env";
import type { Actor } from "../audit";

export type EntryRow = typeof waitlistEntry.$inferSelect;
export type OfferRow = typeof waitlistOffer.$inferSelect;

/** Entry statuses that can still receive offers. */
export const ACTIVE_ENTRY_STATUSES = ["waiting", "offered"] as const;

export const MINUTE_MS = 60_000;

/** Optional injection point for process config, so tests need no environment. */
export interface WaitlistOptions {
  /** Base64 HMAC key for offer and leave tokens. Defaults to ENCRYPTION_KEY from the environment. */
  encryptionKey?: string;
}

/** Resolved lazily so a missing ENCRYPTION_KEY only fails the features that build links. */
export function resolveKey(options: WaitlistOptions = {}): string {
  const key = options.encryptionKey ?? getEnv().ENCRYPTION_KEY;
  if (!key) throw new Error("ENCRYPTION_KEY is not set; it is required to build waitlist links");
  return key;
}

/** The audit actor for an offer: "auto" is the system; "owner:<id>" / "staff:<id>" are people. */
export function actorForOffer(offeredBy: string): Actor {
  if (offeredBy.startsWith("owner:") || offeredBy.startsWith("staff:")) {
    return offeredBy as Actor;
  }
  return "system";
}

/** SQL: the lower bound of a tstzrange column equals `at`. */
export function rangeStartsAt(column: AnyPgColumn, at: Date): SQL {
  return sql`lower(${column}) = ${at.toISOString()}::timestamptz`;
}
