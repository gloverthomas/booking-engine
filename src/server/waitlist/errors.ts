import { DomainError } from "../booking/errors";

/** The business has switched the waitlist off. */
export class WaitlistDisabledError extends DomainError {
  constructor() {
    super("The waitlist is not available right now");
  }
}

export type OfferGoneReason = "expired" | "cancelled" | "claimed";

/** The offer can no longer be claimed (window over, withdrawn, or already claimed). */
export class OfferGoneError extends DomainError {
  constructor(readonly reason: OfferGoneReason) {
    super(
      reason === "expired"
        ? "This offer has expired"
        : reason === "claimed"
          ? "This time has already been claimed"
          : "This offer is no longer available",
    );
  }
}
