import type { CatalogService } from "@/lib/public-api-types";
import type { HoldRequest } from "./api-client";
import type { RememberedClient } from "./remembered-client";

export interface DetailsForm {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  pronouns: string;
  otherPhone: string;
  company: string;
  comments: string;
  bookedForOther: boolean;
  marketingOptIn: boolean;
  policyAccepted: boolean;
  intakeAnswers: Record<string, string>;
}

export const EMPTY_DETAILS: DetailsForm = {
  firstName: "",
  lastName: "",
  email: "",
  phone: "",
  pronouns: "",
  otherPhone: "",
  company: "",
  comments: "",
  bookedForOther: false,
  marketingOptIn: false,
  policyAccepted: false,
  intakeAnswers: {},
};

export type DetailsErrors = Partial<Record<string, string>>;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/** Rough shape check only; the server normalises and fully validates the number. */
function looksLikePhone(value: string): boolean {
  const digits = value.replace(/[^\d]/g, "");
  return /^[+\d][\d\s()-]*$/.test(value.trim()) && digits.length >= 8 && digits.length <= 15;
}

/** Client-side validation. Keys match the server's field-error keys so both render the same way. */
export function validateDetails(
  details: DetailsForm,
  services: readonly CatalogService[],
): DetailsErrors {
  const errors: DetailsErrors = {};
  if (!details.firstName.trim()) errors["client.firstName"] = "First name is required";
  if (!details.lastName.trim()) errors["client.lastName"] = "Last name is required";
  if (!details.email.trim()) errors["client.email"] = "Email is required";
  else if (!EMAIL_RE.test(details.email.trim())) {
    errors["client.email"] = "Enter a valid email address";
  }
  if (!details.phone.trim()) errors["client.phone"] = "Mobile number is required";
  else if (!looksLikePhone(details.phone)) errors["client.phone"] = "Enter a valid mobile number";
  if (details.otherPhone.trim() && !looksLikePhone(details.otherPhone)) {
    errors.otherPhone = "Enter a valid phone number";
  }
  for (const svc of services) {
    for (const q of svc.intakeQuestions) {
      if (q.required && !details.intakeAnswers[q.id]?.trim()) {
        errors[`intakeAnswers.${q.id}`] = "This answer is required";
      }
    }
  }
  if (!details.policyAccepted) {
    errors.policyAccepted = "You need to agree to the cancellation policy to book";
  }
  return errors;
}

export function applyRemembered(details: DetailsForm, remembered: RememberedClient): DetailsForm {
  return { ...details, ...remembered };
}

export function toRemembered(details: DetailsForm): RememberedClient {
  return {
    firstName: details.firstName.trim(),
    lastName: details.lastName.trim(),
    email: details.email.trim(),
    phone: details.phone.trim(),
    pronouns: details.pronouns.trim(),
    otherPhone: details.otherPhone.trim(),
    company: details.company.trim(),
  };
}

export interface HoldRequestInput {
  locationId: string;
  serviceIds: readonly string[];
  slotStart: string;
  details: DetailsForm;
  policyVersion: string;
  turnstileToken?: string;
  staffId?: string;
  staffRequested?: boolean;
}

const opt = (value: string): string | undefined => value.trim() || undefined;

export function buildHoldRequest(input: HoldRequestInput): HoldRequest {
  const { details } = input;
  return {
    locationId: input.locationId,
    serviceIds: [...input.serviceIds],
    start: input.slotStart,
    staffId: input.staffId,
    staffRequested: input.staffId !== undefined && input.staffRequested === true,
    client: {
      firstName: details.firstName.trim(),
      lastName: details.lastName.trim(),
      email: details.email.trim(),
      phone: details.phone.trim(),
      pronouns: opt(details.pronouns),
      marketingOptIn: details.marketingOptIn,
    },
    otherPhone: opt(details.otherPhone),
    company: opt(details.company),
    bookedForOther: details.bookedForOther,
    comments: opt(details.comments),
    intakeAnswers: Object.fromEntries(
      Object.entries(details.intakeAnswers).filter(([, v]) => v.trim() !== ""),
    ),
    policyVersion: input.policyVersion,
    policyAccepted: true,
    turnstileToken: input.turnstileToken,
  };
}
