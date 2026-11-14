import type { CreateHoldInput, HoldResult } from "@/server/contracts";
import type {
  CatalogLocation,
  CatalogService,
  HoldData,
  AvailabilityData,
} from "./public-api-types";
import { toApiError } from "./public-api-errors";
import { ApiError, clientIp, guard, ok, parseOrThrow, readJson } from "./public-api-http";
import type { PublicApiDeps } from "./public-api-deps";
import type { RateLimiter } from "./public-api-rate-limit";
import { availabilityQuerySchema, holdBodySchema, type HoldBody } from "./public-api-schemas";
import { groupSlotsByLocalDay } from "./public-api-slots";
import { addDays, compareDates, daysBetween } from "./public-api-time";

const READ_CACHE = { "Cache-Control": "public, max-age=30, stale-while-revalidate=60" };

/** Throws a 429 when the caller's IP is over budget for `limiter`. */
export function enforceLimit(deps: PublicApiDeps, request: Request, limiter: RateLimiter): void {
  const ip = clientIp(request, deps.trustedProxyHops);
  const result = limiter.check(ip);
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

/** Confirm the location offers every requested service to the public. Returns the services in request order. */
export function resolveSelection(
  locations: readonly CatalogLocation[],
  locationId: string,
  serviceIds: readonly string[],
): { location: CatalogLocation; services: CatalogService[] } {
  const location = locations.find((l) => l.id === locationId);
  if (!location) {
    throw new ApiError(422, "invalid_selection", "That location isn't available for booking.");
  }
  const services: CatalogService[] = [];
  for (const id of new Set(serviceIds)) {
    const svc = location.services.find((s) => s.id === id);
    if (!svc) {
      throw new ApiError(
        422,
        "invalid_selection",
        "One of the selected services isn't available at this location.",
      );
    }
    services.push(svc);
  }
  return { location, services };
}

/* ------------------------------------------------------------------ */
/* GET /api/public/catalog                                             */
/* ------------------------------------------------------------------ */

export function handleCatalog(deps: PublicApiDeps, request: Request): Promise<Response> {
  return guard(
    async () => {
      enforceLimit(deps, request, deps.limiters.read);
      const ctx = await deps.loadBusiness();
      const catalog = await deps.loadCatalog(ctx, deps.now());
      return ok(catalog, { headers: READ_CACHE });
    },
    deps.log,
    "catalog",
  );
}

/* ------------------------------------------------------------------ */
/* GET /api/public/availability                                        */
/* ------------------------------------------------------------------ */

export function handleAvailability(deps: PublicApiDeps, request: Request): Promise<Response> {
  return guard(
    async () => {
      enforceLimit(deps, request, deps.limiters.availability);
      const params = Object.fromEntries(new URL(request.url).searchParams);
      const query = parseOrThrow(availabilityQuerySchema, params);

      const now = deps.now();
      const ctx = await deps.loadBusiness();
      const catalog = await deps.loadCatalog(ctx, now);
      resolveSelection(catalog.locations, query.locationId, query.serviceIds);

      // Clamp to the bookable horizon instead of failing: the month grid asks for whole months.
      const earliest = catalog.today;
      const latest = addDays(catalog.today, ctx.settings.maxAdvanceDays);
      const fromDate = compareDates(query.fromDate, earliest) < 0 ? earliest : query.fromDate;
      const toDate = compareDates(query.toDate, latest) > 0 ? latest : query.toDate;

      const empty: AvailabilityData = {
        timezone: ctx.timezone,
        fromDate,
        toDate,
        days: [],
      };
      if (daysBetween(fromDate, toDate) < 0) return ok(empty);

      const slots = await deps.backend.getAvailableSlots({
        locationId: query.locationId,
        staffId: query.staffId,
        serviceIds: query.serviceIds,
        fromDate,
        toDate,
        now,
      });
      return ok<AvailabilityData>({ ...empty, days: groupSlotsByLocalDay(slots, ctx.timezone) });
    },
    deps.log,
    "availability",
  );
}

/* ------------------------------------------------------------------ */
/* POST /api/public/holds                                              */
/* ------------------------------------------------------------------ */

function requiredIntakeErrors(
  services: readonly CatalogService[],
  answers: Record<string, string>,
): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const svc of services) {
    for (const q of svc.intakeQuestions) {
      if (q.required && !answers[q.id]?.trim()) {
        errors[`intakeAnswers.${q.id}`] = `Please answer: ${q.label}`;
      }
    }
  }
  return errors;
}

/** Keep only answers to questions that belong to the chosen services. */
function relevantAnswers(
  services: readonly CatalogService[],
  answers: Record<string, string>,
): Record<string, string> {
  const known = new Set(services.flatMap((s) => s.intakeQuestions.map((q) => q.id)));
  return Object.fromEntries(
    Object.entries(answers).filter(([key, value]) => known.has(key) && value.trim() !== ""),
  );
}

/**
 * CreateHoldInput has no fields for a second phone number or company, so they ride along in the
 * comments where the stylist sees them on the booking.
 */
export function composeComments(
  body: Partial<Pick<HoldBody, "comments" | "otherPhone" | "company">>,
) {
  const lines = [
    body.comments,
    body.otherPhone ? `Other phone: ${body.otherPhone}` : undefined,
    body.company ? `Company: ${body.company}` : undefined,
  ].filter((l): l is string => Boolean(l));
  return lines.length > 0 ? lines.join("\n") : undefined;
}

async function checkHuman(deps: PublicApiDeps, request: Request, token: string | undefined) {
  const ip = clientIp(request, deps.trustedProxyHops);
  const result = await deps.verifyTurnstile(token, ip);
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
    "Online booking is temporarily unavailable. Please try again shortly.",
  );
}

export function handleCreateHold(deps: PublicApiDeps, request: Request): Promise<Response> {
  return guard(
    async () => {
      enforceLimit(deps, request, deps.limiters.hold);
      const body = parseOrThrow(holdBodySchema, await readJson(request));

      const now = deps.now();
      const ctx = await deps.loadBusiness();
      if (body.policyVersion !== ctx.settings.policyVersion) {
        throw new ApiError(
          409,
          "policy_changed",
          "Our cancellation policy was updated. Please review it and try again.",
        );
      }

      await checkHuman(deps, request, body.turnstileToken);

      const catalog = await deps.loadCatalog(ctx, now);
      const { services } = resolveSelection(catalog.locations, body.locationId, body.serviceIds);
      const intakeErrors = requiredIntakeErrors(services, body.intakeAnswers);
      if (Object.keys(intakeErrors).length > 0) {
        throw new ApiError(422, "validation_failed", Object.values(intakeErrors)[0], intakeErrors);
      }

      const start = new Date(body.start);
      if (start.getTime() <= now.getTime()) {
        throw new ApiError(409, "slot_taken", "That time has passed. Please pick another time.");
      }

      const input: CreateHoldInput = {
        locationId: body.locationId,
        staffId: body.staffId,
        serviceIds: services.map((s) => s.id),
        start,
        client: body.client,
        bookedForOther: body.bookedForOther,
        comments: composeComments(body),
        intakeAnswers: relevantAnswers(services, body.intakeAnswers),
        policyVersion: body.policyVersion,
        source: "online",
        now,
      };

      let hold: HoldResult;
      try {
        hold = await deps.backend.createHold(input);
      } catch (error) {
        throw toApiError(error, "hold") ?? error;
      }

      const data = await finishHold(deps, hold, now);
      deps.log({ event: "hold_created", bookingId: hold.bookingId, confirmed: data.confirmed });
      return ok(data, { status: 201 });
    },
    deps.log,
    "holds",
  );
}

async function finishHold(deps: PublicApiDeps, hold: HoldResult, now: Date): Promise<HoldData> {
  const common = {
    bookingId: hold.bookingId,
    manageToken: hold.manageToken,
    holdExpiresAt: hold.holdExpiresAt.toISOString(),
    serverNow: now.toISOString(),
    totalCents: hold.totalCents,
    depositCents: hold.depositCents,
    start: hold.during.start.toISOString(),
    end: hold.during.end.toISOString(),
  };

  try {
    if (hold.depositCents > 0) {
      const intent = await deps.backend.createDepositIntent(hold.bookingId);
      return {
        ...common,
        confirmed: false,
        payment: {
          clientSecret: intent.clientSecret,
          paymentId: intent.paymentId,
          amountCents: intent.amountCents,
        },
      };
    }
    await deps.backend.confirmBooking(hold.bookingId, now);
    return { ...common, confirmed: true, payment: null };
  } catch (error) {
    // Do not leave the slot blocked for the retry: release our own hold, best effort.
    deps.log({
      level: "error",
      event: "hold_finish_failed",
      bookingId: hold.bookingId,
      error: error instanceof Error ? error.message : String(error),
    });
    try {
      await deps.backend.cancelBooking({
        bookingId: hold.bookingId,
        by: "client",
        reason: "Hold released: payment could not be started",
        now,
      });
    } catch (releaseError) {
      deps.log({
        level: "error",
        event: "hold_release_failed",
        bookingId: hold.bookingId,
        error: releaseError instanceof Error ? releaseError.message : String(releaseError),
      });
    }
    throw new ApiError(
      502,
      "payment_unavailable",
      "We couldn't start your deposit payment. Please try again in a moment.",
    );
  }
}
