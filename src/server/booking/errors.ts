/** Typed domain errors. Callers (API routes, server actions, consumers) branch on the class, not the message. */

export class DomainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** Input failed validation (bad dates, unknown or inactive service, invalid phone, ...). */
export class ValidationError extends DomainError {
  constructor(
    message: string,
    readonly issues: readonly string[] = [],
  ) {
    super(message);
  }
}

export class NotFoundError extends DomainError {}

/** The requested time is not (or is no longer) bookable. Also raised when the DB exclusion constraint fires. */
export class SlotTakenError extends DomainError {
  constructor(message = "That time is no longer available") {
    super(message);
  }
}

export class PolicyVersionError extends DomainError {
  constructor(
    readonly expected: string,
    readonly received: string,
  ) {
    super(`Cancellation policy version mismatch: expected ${expected}, received ${received}`);
  }
}

export class ClientBlockedError extends DomainError {
  constructor() {
    super("This client cannot book online");
  }
}

export class VipOnlyError extends DomainError {
  constructor(serviceName: string) {
    super(`"${serviceName}" is only available to VIP clients`);
  }
}

/** The booking is not in a status that allows the requested transition. */
export class BookingStateError extends DomainError {
  constructor(
    message: string,
    readonly status?: string,
  ) {
    super(message);
  }
}

/** A hold lapsed before it could be confirmed (e.g. payment arrived late). The payments side must refund. */
export class HoldExpiredError extends BookingStateError {
  constructor(status?: string) {
    super("The hold on this booking has expired", status);
  }
}

/** Two clients cannot be merged (same client, already merged, or it would create a cycle). */
export class ClientMergeError extends DomainError {}

/** A client tried to change a booking inside the cancellation window. */
export class ChangeWindowError extends DomainError {
  constructor(readonly windowHours: number) {
    super(`Bookings cannot be changed online within ${windowHours} hours of the start time`);
  }
}

/** Walks `cause` chains (Drizzle wraps driver errors) looking for a Postgres SQLSTATE code. */
export function pgErrorCode(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current && typeof current === "object"; depth += 1) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string") return code;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

/** SQLSTATE 23P01 = exclusion_violation (the booking no_overlap constraint). */
export function isExclusionViolation(error: unknown): boolean {
  return pgErrorCode(error) === "23P01";
}
