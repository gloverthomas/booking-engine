import { z } from "zod";
import {
  ApiError,
  clientIp,
  guard,
  ok,
  parseOrThrow,
  readJson,
  type RequestLog,
} from "@/lib/public-api-http";
import { RateLimiter } from "@/lib/public-api-rate-limit";
import { phoneSchema } from "@/lib/public-api-schemas";
import { isValidDateString } from "@/lib/public-api-time";
import type { TurnstileResult } from "@/lib/turnstile";
import {
  BookingStateError,
  ClientBlockedError,
  NotFoundError,
  PolicyVersionError,
  SlotTakenError,
  ValidationError,
} from "../booking/errors";
import type { PaymentIntentResult } from "../contracts";
import type { Db } from "../db-types";
import { claimOffer, getOfferView, loadBillingDetails } from "./claim";
import { getEntryByToken, leaveWaitlistByToken, makeLeaveToken } from "./entry";
import { OfferGoneError, WaitlistDisabledError } from "./errors";
import { joinWaitlist } from "./join";
import type { WaitlistOptions } from "./shared";
import type {
  WaitlistClaimData,
  WaitlistEntryData,
  WaitlistJoinedData,
  WaitlistLeftData,
  WaitlistOfferData,
} from "./wire";
import { TIME_OF_DAY, describeTimeOfDay, describeWeekdays } from "./window";

/* ------------------------------------------------------------------ */
/* Dependencies                                                        */
/* ------------------------------------------------------------------ */

export interface WaitlistLimiters {
  read: RateLimiter;
  join: RateLimiter;
  claim: RateLimiter;
  leave: RateLimiter;
}

/** Per-IP budgets. Joining is the abuse target (it can message people later), so it is tightest. */
export function createWaitlistLimiters(now: () => number = Date.now): WaitlistLimiters {
  return {
    read: new RateLimiter(120, 60_000, now),
    join: new RateLimiter(6, 10 * 60_000, now),
    claim: new RateLimiter(15, 10 * 60_000, now),
    leave: new RateLimiter(15, 10 * 60_000, now),
  };
}

/** Everything the handlers touch. Tests pass fakes; production wiring lives beside the routes. */
export interface WaitlistApiDeps {
  db: Db;
  now(): Date;
  log: RequestLog;
  limiters: WaitlistLimiters;
  trustedProxyHops: number;
  verifyTurnstile(token: string | undefined, ip: string): Promise<TurnstileResult>;
  /** Key for offer and leave tokens. Throws a clear error when ENCRYPTION_KEY is missing. */
  tokenOptions(): WaitlistOptions;
  createDepositIntent(bookingId: string): Promise<PaymentIntentResult>;
  confirmBooking(bookingId: string, now: Date): Promise<void>;
}

function enforce(deps: WaitlistApiDeps, request: Request, limiter: RateLimiter): void {
  const result = limiter.check(clientIp(request, deps.trustedProxyHops));
  if (!result.allowed) {
    throw new ApiError(
      429,
      "rate_limited",
      "You're going a little fast. Please wait a moment and try again.",
      undefined,
      { "Retry-After": String(result.retryAfterSec) },
    );
  }
}

/* ------------------------------------------------------------------ */
/* Errors                                                              */
/* ------------------------------------------------------------------ */

const CLIENT_FIELDS = new Set(["firstName", "lastName", "email", "phone"]);

function fieldErrorsFromIssues(issues: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of issues) {
    const colon = issue.indexOf(": ");
    if (colon <= 0) continue;
    const path = issue.slice(0, colon);
    out[CLIENT_FIELDS.has(path) ? `client.${path}` : path] ??= issue.slice(colon + 2);
  }
  return out;
}

/** Friendly API errors for the domain errors the waitlist can raise; null for anything unexpected. */
export function toWaitlistApiError(error: unknown): ApiError | null {
  if (error instanceof OfferGoneError) {
    return new ApiError(410, "offer_gone", error.message, { reason: error.reason });
  }
  if (error instanceof SlotTakenError) return new ApiError(409, "slot_taken", error.message);
  if (error instanceof PolicyVersionError) {
    return new ApiError(
      409,
      "policy_changed",
      "Our cancellation policy was updated. Please review it and try again.",
    );
  }
  if (error instanceof NotFoundError) {
    return new ApiError(404, "not_found", "We couldn't find that. Check the link in your message.");
  }
  if (error instanceof WaitlistDisabledError) {
    return new ApiError(409, "waitlist_disabled", error.message);
  }
  if (error instanceof ClientBlockedError) {
    return new ApiError(
      403,
      "unavailable",
      "We can't take this request online. Please contact the salon.",
    );
  }
  if (error instanceof BookingStateError) {
    return new ApiError(409, "invalid_state", "That can't be changed any more.");
  }
  if (error instanceof ValidationError) {
    const fieldErrors = fieldErrorsFromIssues(error.issues);
    const message = Object.values(fieldErrors)[0] ?? error.message;
    return new ApiError(422, "validation_failed", message, fieldErrors);
  }
  return null;
}

async function mapped<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    throw toWaitlistApiError(error) ?? error;
  }
}

/* ------------------------------------------------------------------ */
/* Schemas                                                             */
/* ------------------------------------------------------------------ */

const id = z.guid("Invalid identifier");
const required = (label: string, max: number) =>
  z.string().trim().min(1, `${label} is required`).max(max, `Keep this under ${max} characters`);
const localDate = z.string().refine(isValidDateString, "Use a date like 2026-11-20");

export const joinBodySchema = z
  .object({
    client: z.object({
      firstName: required("First name", 60),
      lastName: required("Last name", 60),
      email: z
        .string()
        .trim()
        .min(1, "Email is required")
        .pipe(z.email("Enter a valid email address"))
        .transform((v) => v.toLowerCase()),
      phone: phoneSchema,
      marketingOptIn: z.boolean().default(false),
    }),
    locationId: id,
    staffId: id.optional(),
    serviceIds: z.array(id).min(1, "Choose at least one service").max(10),
    earliestDate: localDate,
    latestDate: localDate,
    weekdays: z.array(z.number().int().min(0).max(6)).max(7).optional(),
    timeOfDay: z.enum(["any", "morning", "afternoon"]).default("any"),
    notes: z.string().trim().max(500).optional(),
    turnstileToken: z.string().max(2048).optional(),
  })
  .refine((v) => v.earliestDate <= v.latestDate, {
    path: ["latestDate"],
    message: "The last date can't be before the first date",
  });

export const claimBodySchema = z.object({
  policyVersion: z.string().min(1).max(64),
  policyAccepted: z.literal(true, "You need to agree to the cancellation policy"),
});

const tokenSchema = z.string().min(10).max(300);

/* ------------------------------------------------------------------ */
/* POST /api/public/waitlist                                           */
/* ------------------------------------------------------------------ */

async function checkHuman(deps: WaitlistApiDeps, request: Request, token: string | undefined) {
  const result = await deps.verifyTurnstile(token, clientIp(request, deps.trustedProxyHops));
  if (result.ok) return;
  if (result.reason === "missing_token" || result.reason === "rejected") {
    throw new ApiError(
      400,
      "captcha_failed",
      "We couldn't confirm you're human. Please try again.",
    );
  }
  deps.log({ level: "error", event: "turnstile_unavailable", reason: result.reason });
  throw new ApiError(
    503,
    "service_unavailable",
    "The waitlist is temporarily unavailable. Please try again shortly.",
  );
}

export function handleJoin(deps: WaitlistApiDeps, request: Request): Promise<Response> {
  return guard(
    async () => {
      enforce(deps, request, deps.limiters.join);
      const body = parseOrThrow(joinBodySchema, await readJson(request));
      await checkHuman(deps, request, body.turnstileToken);

      const window = TIME_OF_DAY[body.timeOfDay];
      const { entryId } = await mapped(() =>
        joinWaitlist(deps.db, {
          client: body.client,
          locationId: body.locationId,
          staffId: body.staffId,
          serviceIds: body.serviceIds,
          earliestDate: body.earliestDate,
          latestDate: body.latestDate,
          weekdays: body.weekdays,
          fromMinute: window?.fromMinute,
          toMinute: window?.toMinute,
          notes: body.notes,
          now: deps.now(),
        }),
      );
      deps.log({ event: "waitlist_joined", entryId });
      return ok<WaitlistJoinedData>(
        { leaveToken: makeLeaveToken(entryId, deps.tokenOptions()) },
        { status: 201 },
      );
    },
    deps.log,
    "waitlist-join",
  );
}

/* ------------------------------------------------------------------ */
/* GET /api/public/waitlist/offers/[token]                             */
/* ------------------------------------------------------------------ */

export function handleGetOffer(
  deps: WaitlistApiDeps,
  request: Request,
  token: string,
): Promise<Response> {
  return guard(
    async () => {
      enforce(deps, request, deps.limiters.read);
      const now = deps.now();
      const view = await getOfferView(
        deps.db,
        parseOrThrow(tokenSchema, token),
        now,
        deps.tokenOptions(),
      );
      if (!view) throw new ApiError(404, "not_found", "We couldn't find that offer.");
      return ok<WaitlistOfferData>({
        offerId: view.offerId,
        status: view.status,
        start: view.start.toISOString(),
        end: view.end.toISOString(),
        expiresAt: view.expiresAt.toISOString(),
        serverNow: now.toISOString(),
        timezone: view.timezone,
        businessName: view.businessName,
        staffName: view.staffName,
        locationName: view.locationName,
        locationAddress: view.locationAddress,
        services: view.services,
        totalCents: view.totalCents,
        depositCents: view.depositCents,
        policy: view.policy,
        bookingStatus: view.bookingStatus,
        manageToken: view.manageToken,
        resumable: view.resumable,
      });
    },
    deps.log,
    "waitlist-offer",
  );
}

/* ------------------------------------------------------------------ */
/* POST /api/public/waitlist/offers/[token]/claim                      */
/* ------------------------------------------------------------------ */

/**
 * Claim the time, then start the deposit payment. A failure to start payment leaves the claim in place:
 * claiming again resumes the same held booking, so the person can simply retry.
 */
export function handleClaim(
  deps: WaitlistApiDeps,
  request: Request,
  token: string,
): Promise<Response> {
  return guard(
    async () => {
      enforce(deps, request, deps.limiters.claim);
      const body = parseOrThrow(claimBodySchema, await readJson(request));
      const now = deps.now();
      const hold = await mapped(() =>
        claimOffer(deps.db, parseOrThrow(tokenSchema, token), now, {
          ...deps.tokenOptions(),
          policyVersion: body.policyVersion,
        }),
      );

      const common = {
        bookingId: hold.bookingId,
        manageToken: hold.manageToken,
        holdExpiresAt: hold.holdExpiresAt.toISOString(),
        serverNow: now.toISOString(),
        totalCents: hold.totalCents,
        depositCents: hold.depositCents,
        start: hold.during.start.toISOString(),
        end: hold.during.end.toISOString(),
        billing: await loadBillingDetails(deps.db, hold.bookingId),
      };

      try {
        if (hold.depositCents > 0) {
          const intent = await deps.createDepositIntent(hold.bookingId);
          return ok<WaitlistClaimData>(
            {
              ...common,
              confirmed: false,
              payment: {
                clientSecret: intent.clientSecret,
                paymentId: intent.paymentId,
                amountCents: intent.amountCents,
              },
            },
            { status: 201 },
          );
        }
        await deps.confirmBooking(hold.bookingId, now);
        return ok<WaitlistClaimData>(
          { ...common, confirmed: true, payment: null },
          { status: 201 },
        );
      } catch (error) {
        deps.log({
          level: "error",
          event: "waitlist_claim_payment_failed",
          bookingId: hold.bookingId,
          error: error instanceof Error ? error.message : String(error),
        });
        throw new ApiError(
          502,
          "payment_unavailable",
          "We couldn't start your deposit payment. Your time is still held, so please try again in a moment.",
        );
      }
    },
    deps.log,
    "waitlist-claim",
  );
}

/* ------------------------------------------------------------------ */
/* GET /api/public/waitlist/entries/[token]  and  POST .../leave       */
/* ------------------------------------------------------------------ */

export function handleGetEntry(
  deps: WaitlistApiDeps,
  request: Request,
  token: string,
): Promise<Response> {
  return guard(
    async () => {
      enforce(deps, request, deps.limiters.read);
      const view = await getEntryByToken(
        deps.db,
        parseOrThrow(tokenSchema, token),
        deps.tokenOptions(),
      );
      if (!view) throw new ApiError(404, "not_found", "We couldn't find that waitlist request.");
      return ok<WaitlistEntryData>({
        status: view.status,
        locationName: view.locationName,
        staffName: view.staffName,
        serviceNames: view.serviceNames,
        earliestDate: view.earliestDate,
        latestDate: view.latestDate,
        daysLabel: describeWeekdays(view.weekdays),
        timeLabel: describeTimeOfDay(view),
      });
    },
    deps.log,
    "waitlist-entry",
  );
}

export function handleLeave(
  deps: WaitlistApiDeps,
  request: Request,
  token: string,
): Promise<Response> {
  return guard(
    async () => {
      enforce(deps, request, deps.limiters.leave);
      const left = await leaveWaitlistByToken(deps.db, parseOrThrow(tokenSchema, token), {
        ...deps.tokenOptions(),
        now: deps.now(),
      });
      if (!left) throw new ApiError(404, "not_found", "We couldn't find that waitlist request.");
      return ok<WaitlistLeftData>({ left: true });
    },
    deps.log,
    "waitlist-leave",
  );
}
