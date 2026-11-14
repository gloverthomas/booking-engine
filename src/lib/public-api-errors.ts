import { ApiError } from "./public-api-http";

/**
 * Maps errors thrown by the domain core (workstream A) and payments (C) to friendly API errors.
 *
 * The contracts do not define error types yet, so this accepts any of: a `code` string property,
 * a Postgres SQLSTATE (23P01 = exclusion violation from the no-overlap constraint), or a message
 * pattern. When the domain errors are finalised, agree the codes below and drop the regexes.
 */

export type DomainFailure =
  | "slot_taken"
  | "policy_changed"
  | "too_late"
  | "not_found"
  | "invalid_state"
  | "client_blocked"
  | "unknown";

const CODE_MAP: Record<string, DomainFailure> = {
  slot_taken: "slot_taken",
  slot_unavailable: "slot_taken",
  no_overlap: "slot_taken",
  "23P01": "slot_taken",
  policy_version_mismatch: "policy_changed",
  policy_changed: "policy_changed",
  too_late: "too_late",
  within_window: "too_late",
  outside_policy: "too_late",
  too_soon: "too_late",
  not_found: "not_found",
  invalid_state: "invalid_state",
  invalid_status: "invalid_state",
  client_blocked: "client_blocked",
};

const MESSAGE_PATTERNS: Array<[RegExp, DomainFailure]> = [
  [/overlap|no_overlap|slot.*(taken|unavailable|no longer)|conflict/i, "slot_taken"],
  [/policy.*(version|changed)/i, "policy_changed"],
  [/within.*(window|hours)|too late|too soon|notice/i, "too_late"],
  [/not found/i, "not_found"],
  [/invalid (status|state)|already (cancelled|completed|confirmed|expired)/i, "invalid_state"],
  [/blocked/i, "client_blocked"],
];

export function classifyDomainError(error: unknown): DomainFailure {
  if (typeof error === "object" && error !== null) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" && code in CODE_MAP) return CODE_MAP[code];
    const cause = (error as { cause?: unknown }).cause;
    if (cause && cause !== error) {
      const nested = classifyDomainError(cause);
      if (nested !== "unknown") return nested;
    }
  }
  const message = error instanceof Error ? error.message : "";
  for (const [pattern, failure] of MESSAGE_PATTERNS) {
    if (pattern.test(message)) return failure;
  }
  return "unknown";
}

export type BookingAction = "hold" | "cancel" | "reschedule";

/** Translate a domain failure into an ApiError, or null when it is unexpected (caller rethrows). */
export function toApiError(error: unknown, action: BookingAction): ApiError | null {
  switch (classifyDomainError(error)) {
    case "slot_taken":
      return new ApiError(
        409,
        "slot_taken",
        "Sorry, that time was just taken. Please pick another time.",
      );
    case "policy_changed":
      return new ApiError(
        409,
        "policy_changed",
        "Our cancellation policy was updated. Please review it and try again.",
      );
    case "too_late":
      return new ApiError(
        409,
        "outside_policy",
        action === "reschedule"
          ? "This booking is too close to move online. Please contact the salon."
          : "This booking is too close to the appointment to change online. Please contact the salon.",
      );
    case "not_found":
      return new ApiError(404, "not_found", "We couldn't find that booking.");
    case "invalid_state":
      return new ApiError(
        409,
        "invalid_state",
        "This booking can't be changed any more. Please contact the salon if you need help.",
      );
    case "client_blocked":
      return new ApiError(
        403,
        "unavailable",
        "We can't take this booking online. Please contact the salon.",
      );
    default:
      return null;
  }
}
