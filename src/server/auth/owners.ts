/**
 * Owner allow-list. Only emails listed in OWNER_EMAILS may sign in to the admin.
 * Pure functions, no I/O, so the rules are trivial to test and impossible to bypass by config drift:
 * an unset or empty list admits nobody (fail closed).
 */

export const NOT_AUTHORISED_CODE = "not_authorised";
export const EMAIL_NOT_VERIFIED_CODE = "email_not_verified";

export function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** Parse the comma-separated OWNER_EMAILS value into a lowercase set. */
export function parseOwnerEmails(raw: string | undefined): ReadonlySet<string> {
  const emails = (raw ?? "")
    .split(",")
    .map(normaliseEmail)
    .filter((email) => email.length > 0);
  return new Set(emails);
}

export function isOwnerEmail(
  email: string | null | undefined,
  owners: ReadonlySet<string>,
): boolean {
  if (!email) return false;
  return owners.has(normaliseEmail(email));
}

export interface IdentityRejection {
  error: string;
  errorDescription: string;
}

export interface IdentityClaim {
  email?: string | null;
  emailVerified?: boolean | null;
}

/** Decide whether an identity from the sign-in provider may get (or keep) an account. Null means admit. */
export function evaluateIdentity(
  claim: IdentityClaim,
  owners: ReadonlySet<string>,
): IdentityRejection | null {
  if (!isOwnerEmail(claim.email, owners)) {
    return {
      error: NOT_AUTHORISED_CODE,
      errorDescription: "This Google account is not authorised to use the admin.",
    };
  }
  if (claim.emailVerified === false) {
    return {
      error: EMAIL_NOT_VERIFIED_CODE,
      errorDescription: "Google has not verified this email address.",
    };
  }
  return null;
}

/** Plain-English message for the error code Better Auth puts on the login URL. */
export function loginErrorMessage(code: string | undefined): string | null {
  if (!code) return null;
  switch (code) {
    case NOT_AUTHORISED_CODE:
    case "unable_to_create_user":
      return "That Google account is not authorised to use this admin. Sign in with the owner account, or ask the owner to add yours.";
    case EMAIL_NOT_VERIFIED_CODE:
      return "Google says that email address is not verified, so we can't let it in.";
    case "access_denied":
      return "Sign-in was cancelled or denied. Try again when you're ready.";
    default:
      return "We couldn't sign you in. Please try again.";
  }
}
