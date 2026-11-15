import type { CancelOutcome, PublicBookingSummary } from "@/server/contracts";
import { toApiError } from "./public-api-errors";
import { ApiError, guard, ok, parseOrThrow, readJson } from "./public-api-http";
import type { PublicApiDeps } from "./public-api-deps";
import { enforceLimit } from "./public-api-handlers";
import { buildIcs } from "./public-api-ics";
import { cancelResultMessage, describeCancellation } from "./public-api-policy";
import { cancelBodySchema, rescheduleBodySchema } from "./public-api-schemas";
import type { CancelData, ManageBookingData, RescheduleData } from "./public-api-types";
import type { BookingContext, BusinessContext } from "./public-api-catalog";

const MAX_TOKEN_LENGTH = 200;

const notFound = () => new ApiError(404, "not_found", "We couldn't find that booking.");

interface Resolved {
  summary: PublicBookingSummary;
  business: BusinessContext;
  context: BookingContext;
}

/** Token to booking, or a uniform 404 for anything unknown, forged or malformed. */
async function resolveBooking(deps: PublicApiDeps, token: string): Promise<Resolved> {
  if (!token || token.length > MAX_TOKEN_LENGTH) throw notFound();
  const bookingId = deps.verifyManageToken(token);
  if (!bookingId) throw notFound();

  const summary = await deps.backend.getBookingByToken(token);
  if (!summary || summary.bookingId !== bookingId) throw notFound();

  const [business, context] = await Promise.all([
    deps.loadBusiness(),
    deps.loadBookingContext(bookingId),
  ]);
  if (!context) throw notFound();
  return { summary, business, context };
}

function cancellationFor(deps: PublicApiDeps, r: Resolved) {
  return describeCancellation({
    status: r.summary.status,
    start: r.summary.start,
    now: deps.now(),
    depositCents: r.summary.depositCents,
    settings: r.business.settings,
  });
}

export function handleGetBooking(deps: PublicApiDeps, request: Request, token: string) {
  return guard(
    async () => {
      enforceLimit(deps, request, deps.limiters.read);
      const r = await resolveBooking(deps, token);
      const { summary } = r;
      const data: ManageBookingData = {
        booking: {
          bookingId: summary.bookingId,
          status: summary.status,
          start: summary.start.toISOString(),
          end: summary.end.toISOString(),
          locationName: summary.locationName,
          services: summary.services,
          totalCents: summary.totalCents,
          depositCents: summary.depositCents,
        },
        location: {
          id: r.context.locationId,
          name: r.context.locationName,
          address: r.context.address,
          arrivalNote: r.context.arrivalNote,
          phone: r.context.phone,
        },
        serviceIds: r.context.serviceIds,
        staffId: r.context.staffId,
        staffName:
          r.business.settings.chooseStaff || r.context.staffRequested ? r.context.staffName : null,
        businessName: r.business.name,
        timezone: r.business.timezone,
        now: deps.now().toISOString(),
        maxAdvanceDays: r.business.settings.maxAdvanceDays,
        cancellation: cancellationFor(deps, r),
      };
      return ok(data);
    },
    deps.log,
    "booking.get",
  );
}

export function handleCancelBooking(deps: PublicApiDeps, request: Request, token: string) {
  return guard(
    async () => {
      enforceLimit(deps, request, deps.limiters.mutate);
      const raw = await readJson(request).catch(() => ({}));
      const body = parseOrThrow(cancelBodySchema, raw ?? {});
      const r = await resolveBooking(deps, token);
      const info = cancellationFor(deps, r);
      if (!info.canCancel) {
        throw new ApiError(
          409,
          "outside_policy",
          info.blockedReason ?? "This booking can't be cancelled online.",
        );
      }

      let outcome: CancelOutcome;
      try {
        outcome = await deps.backend.cancelBooking({
          bookingId: r.summary.bookingId,
          by: "client",
          reason: body.reason,
          now: deps.now(),
        });
      } catch (error) {
        throw toApiError(error, "cancel") ?? error;
      }

      const data: CancelData = {
        status: outcome.status === "late_cancelled" ? "late_cancelled" : "cancelled_by_client",
        depositAction: outcome.depositAction,
        message: cancelResultMessage(
          outcome.depositAction,
          info.depositOutcome,
          r.summary.depositCents,
          info.windowHours,
        ),
      };
      deps.log({
        event: "booking_cancelled_by_client",
        bookingId: r.summary.bookingId,
        status: outcome.status,
      });
      return ok(data);
    },
    deps.log,
    "booking.cancel",
  );
}

export function handleRescheduleBooking(deps: PublicApiDeps, request: Request, token: string) {
  return guard(
    async () => {
      enforceLimit(deps, request, deps.limiters.mutate);
      const body = parseOrThrow(rescheduleBodySchema, await readJson(request));
      const r = await resolveBooking(deps, token);
      const info = cancellationFor(deps, r);
      if (!info.canReschedule) {
        throw new ApiError(
          409,
          "outside_policy",
          info.blockedReason ?? "This booking can't be moved online.",
        );
      }

      const now = deps.now();
      const newStart = new Date(body.start);
      if (newStart.getTime() <= now.getTime()) {
        throw new ApiError(409, "slot_taken", "That time has passed. Please pick another time.");
      }

      try {
        await deps.backend.rescheduleBooking({
          bookingId: r.summary.bookingId,
          newStart,
          by: "client",
          notifyClient: true,
          now,
        });
      } catch (error) {
        throw toApiError(error, "reschedule") ?? error;
      }

      const durationMs = r.summary.end.getTime() - r.summary.start.getTime();
      const data: RescheduleData = {
        start: newStart.toISOString(),
        end: new Date(newStart.getTime() + durationMs).toISOString(),
      };
      deps.log({ event: "booking_rescheduled_by_client", bookingId: r.summary.bookingId });
      return ok(data);
    },
    deps.log,
    "booking.reschedule",
  );
}

/** GET .../ics: a calendar file for the appointment. Only confirmed bookings have one. */
export function handleBookingIcs(deps: PublicApiDeps, request: Request, token: string) {
  return guard(
    async () => {
      enforceLimit(deps, request, deps.limiters.read);
      const r = await resolveBooking(deps, token);
      if (r.summary.status !== "confirmed") throw notFound();

      const serviceNames = r.summary.services.map((s) => s.name).join(", ");
      const body = buildIcs({
        uid: `${r.summary.bookingId}@bookings`,
        title: `${serviceNames} with ${r.business.name}`,
        description: [
          `Services: ${serviceNames}`,
          r.context.arrivalNote ?? "",
          "Need to change it? Use the manage link in your confirmation.",
        ]
          .filter(Boolean)
          .join("\n"),
        location: [r.context.locationName, r.context.address].filter(Boolean).join(", "),
        start: r.summary.start,
        end: r.summary.end,
        now: deps.now(),
      });
      return new Response(body, {
        headers: {
          "Content-Type": "text/calendar; charset=utf-8",
          "Content-Disposition": 'attachment; filename="appointment.ics"',
          "Cache-Control": "no-store",
        },
      });
    },
    deps.log,
    "booking.ics",
  );
}
