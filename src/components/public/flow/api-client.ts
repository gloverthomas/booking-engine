import type {
  ApiErrorBody,
  AvailabilityData,
  CancelData,
  CatalogData,
  HoldData,
  ManageBookingData,
  RescheduleData,
} from "@/lib/public-api-types";

export type ApiResult<T> =
  { ok: true; data: T } | { ok: false; status: number; error: ApiErrorBody };

export interface HoldRequest {
  locationId: string;
  serviceIds: string[];
  start: string;
  /** The stylist: asked for by the client, or the one the chosen time is with. */
  staffId?: string;
  /** True only when the client picked this stylist themselves. */
  staffRequested: boolean;
  client: {
    firstName: string;
    lastName: string;
    email: string;
    phone: string;
    marketingOptIn: boolean;
  };
  bookedForOther: boolean;
  comments?: string;
  intakeAnswers: Record<string, string>;
  policyVersion: string;
  policyAccepted: true;
  turnstileToken?: string;
}

export interface AvailabilityRequest {
  locationId: string;
  serviceIds: string[];
  fromDate: string;
  toDate: string;
  staffId?: string;
}

const NETWORK_ERROR: ApiErrorBody = {
  code: "network",
  message: "We couldn't reach the booking system. Check your connection and try again.",
};

const BAD_RESPONSE: ApiErrorBody = {
  code: "bad_response",
  message: "Something unexpected happened. Please try again.",
};

function isEnvelope(
  value: unknown,
): value is { success: boolean; data?: unknown; error?: unknown } {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { success?: unknown }).success === "boolean"
  );
}

function isErrorBody(value: unknown): value is ApiErrorBody {
  const v = value as Partial<ApiErrorBody> | null;
  return !!v && typeof v.code === "string" && typeof v.message === "string";
}

/** Thin typed wrapper over the public API. Never throws: failures come back as `{ ok: false }`. */
export function createApiClient(
  fetchImpl: typeof fetch = (...args) => fetch(...args),
  base = "/api/public",
) {
  async function call<T>(path: string, init?: RequestInit): Promise<ApiResult<T>> {
    let response: Response;
    try {
      response = await fetchImpl(`${base}${path}`, init);
    } catch {
      return { ok: false, status: 0, error: NETWORK_ERROR };
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      return { ok: false, status: response.status, error: BAD_RESPONSE };
    }
    if (!isEnvelope(body)) return { ok: false, status: response.status, error: BAD_RESPONSE };
    if (body.success) return { ok: true, data: body.data as T };
    return {
      ok: false,
      status: response.status,
      error: isErrorBody(body.error) ? body.error : BAD_RESPONSE,
    };
  }

  const json = (method: string, payload: unknown): RequestInit => ({
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  return {
    catalog: () => call<CatalogData>("/catalog"),

    availability: (req: AvailabilityRequest) => {
      const params = new URLSearchParams({
        locationId: req.locationId,
        serviceIds: req.serviceIds.join(","),
        fromDate: req.fromDate,
        toDate: req.toDate,
      });
      if (req.staffId) params.set("staffId", req.staffId);
      return call<AvailabilityData>(`/availability?${params.toString()}`);
    },

    createHold: (req: HoldRequest) => call<HoldData>("/holds", json("POST", req)),

    booking: (token: string) => call<ManageBookingData>(`/bookings/${encodeURIComponent(token)}`),

    cancel: (token: string, reason?: string) =>
      call<CancelData>(`/bookings/${encodeURIComponent(token)}/cancel`, json("POST", { reason })),

    reschedule: (token: string, start: string) =>
      call<RescheduleData>(
        `/bookings/${encodeURIComponent(token)}/reschedule`,
        json("POST", { start }),
      ),

    icsUrl: (token: string) => `${base}/bookings/${encodeURIComponent(token)}/ics`,
  };
}

export type ApiClient = ReturnType<typeof createApiClient>;
