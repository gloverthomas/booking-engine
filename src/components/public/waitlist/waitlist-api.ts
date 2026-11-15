import type { ApiErrorBody } from "@/lib/public-api-types";
import type {
  WaitlistClaimData,
  WaitlistEntryData,
  WaitlistJoinedData,
  WaitlistLeftData,
  WaitlistOfferData,
} from "@/server/waitlist/wire";
import type { ApiResult } from "../flow/api-client";
import type { JoinRequest } from "./form";

const NETWORK_ERROR: ApiErrorBody = {
  code: "network",
  message: "We couldn't reach the booking system. Check your connection and try again.",
};
const BAD_RESPONSE: ApiErrorBody = {
  code: "bad_response",
  message: "Something unexpected happened. Please try again.",
};

function isErrorBody(value: unknown): value is ApiErrorBody {
  const v = value as Partial<ApiErrorBody> | null;
  return !!v && typeof v.code === "string" && typeof v.message === "string";
}

/** Thin typed wrapper over /api/public/waitlist. Never throws: failures come back as `{ ok: false }`. */
export function createWaitlistClient(
  fetchImpl: typeof fetch = (...args) => fetch(...args),
  base = "/api/public/waitlist",
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
    const envelope = body as { success?: unknown; data?: unknown; error?: unknown } | null;
    if (!envelope || typeof envelope.success !== "boolean") {
      return { ok: false, status: response.status, error: BAD_RESPONSE };
    }
    if (envelope.success) return { ok: true, data: envelope.data as T };
    return {
      ok: false,
      status: response.status,
      error: isErrorBody(envelope.error) ? envelope.error : BAD_RESPONSE,
    };
  }

  const post = (payload: unknown): RequestInit => ({
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const enc = encodeURIComponent;

  return {
    join: (request: JoinRequest) => call<WaitlistJoinedData>("", post(request)),
    offer: (token: string) => call<WaitlistOfferData>(`/offers/${enc(token)}`),
    claim: (token: string, policyVersion: string) =>
      call<WaitlistClaimData>(
        `/offers/${enc(token)}/claim`,
        post({ policyVersion, policyAccepted: true }),
      ),
    entry: (token: string) => call<WaitlistEntryData>(`/entries/${enc(token)}`),
    leave: (token: string) => call<WaitlistLeftData>(`/entries/${enc(token)}/leave`, post({})),
  };
}

export type WaitlistClient = ReturnType<typeof createWaitlistClient>;
