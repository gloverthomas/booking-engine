/**
 * Provider-neutral error taxonomy. Adapters translate SDK/HTTP failures into these so the
 * consumers can decide whether to retry, back off or ask the owner to reconnect.
 */

export class IntegrationError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** Refresh token revoked/expired or access forbidden: the owner has to reconnect. */
export class AuthRevokedError extends IntegrationError {}

/** The remote object does not exist (404). */
export class ProviderNotFoundError extends IntegrationError {}

/** 410 Gone: a deleted object, or an expired Google sync token. */
export class ProviderGoneError extends IntegrationError {}

/** 409: the object already exists. */
export class ProviderConflictError extends IntegrationError {}

/** The provider rejected the request payload (4xx). Retrying the same request cannot help. */
export class ProviderValidationError extends IntegrationError {}

/** Our own configuration is incomplete (e.g. no clearing account chosen yet). */
export class NotConfiguredError extends IntegrationError {}

/** The integration is not connected, so there is nothing to push to. */
export class NotConnectedError extends IntegrationError {}

/** 429 or quota. `retryAfterSec` comes from the Retry-After header when present. */
export class RateLimitedError extends IntegrationError {
  constructor(
    message: string,
    readonly retryAfterSec: number,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

/** Network failure or 5xx. Worth retrying. */
export class TransientProviderError extends IntegrationError {}

/** True when retrying the same operation later can succeed without the owner doing anything. */
export function isRetryable(error: unknown): boolean {
  return !(
    error instanceof AuthRevokedError ||
    error instanceof ProviderValidationError ||
    error instanceof NotConfiguredError ||
    error instanceof NotConnectedError
  );
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown error";
}
