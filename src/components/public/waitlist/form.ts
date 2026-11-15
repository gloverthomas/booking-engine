import { addDays, isValidDateString } from "@/lib/public-api-time";

export type TimeOfDay = "any" | "morning" | "afternoon";

export interface JoinForm {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  earliestDate: string;
  latestDate: string;
  /** 0 = Sunday ... 6 = Saturday. Empty = any day. */
  weekdays: number[];
  timeOfDay: TimeOfDay;
  marketingOptIn: boolean;
}

export type JoinErrors = Partial<Record<string, string>>;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/** Default window: from the day they were looking at (or today) for two weeks. */
export function initialForm(today: string, date?: string): JoinForm {
  const start = date && isValidDateString(date) && date >= today ? date : today;
  return {
    firstName: "",
    lastName: "",
    email: "",
    phone: "",
    earliestDate: start,
    latestDate: addDays(start, 14),
    weekdays: [],
    timeOfDay: "any",
    marketingOptIn: false,
  };
}

/** Returns a new weekday list with `day` switched on or off. */
export function toggleWeekday(weekdays: readonly number[], day: number): number[] {
  return weekdays.includes(day)
    ? weekdays.filter((d) => d !== day)
    : [...weekdays, day].sort((a, b) => a - b);
}

/** Client-side checks. Keys match the server's field-error keys. */
export function validateJoin(form: JoinForm, today: string, horizon: string): JoinErrors {
  const errors: JoinErrors = {};
  if (!form.firstName.trim()) errors["client.firstName"] = "First name is required";
  if (!form.lastName.trim()) errors["client.lastName"] = "Last name is required";
  if (!form.email.trim()) errors["client.email"] = "Email is required";
  else if (!EMAIL_RE.test(form.email.trim()))
    errors["client.email"] = "Enter a valid email address";
  const digits = form.phone.replace(/[^\d]/g, "");
  if (!form.phone.trim()) errors["client.phone"] = "Mobile number is required";
  else if (digits.length < 8 || digits.length > 15) {
    errors["client.phone"] = "Enter a valid mobile number";
  }
  if (!isValidDateString(form.earliestDate)) errors.earliestDate = "Choose a first date";
  else if (form.earliestDate < today) errors.earliestDate = "That date has passed";
  if (!isValidDateString(form.latestDate)) errors.latestDate = "Choose a last date";
  else if (form.latestDate > horizon) {
    errors.latestDate = `We can only look ahead to ${horizon}`;
  } else if (isValidDateString(form.earliestDate) && form.latestDate < form.earliestDate) {
    errors.latestDate = "The last date can't be before the first date";
  }
  return errors;
}

export interface JoinRequest {
  client: {
    firstName: string;
    lastName: string;
    email: string;
    phone: string;
    marketingOptIn: boolean;
  };
  locationId: string;
  staffId?: string;
  serviceIds: string[];
  earliestDate: string;
  latestDate: string;
  weekdays?: number[];
  timeOfDay: TimeOfDay;
  turnstileToken?: string;
}

export function buildJoinRequest(
  form: JoinForm,
  selection: { locationId: string; serviceIds: string[]; staffId?: string },
  turnstileToken?: string,
): JoinRequest {
  return {
    client: {
      firstName: form.firstName.trim(),
      lastName: form.lastName.trim(),
      email: form.email.trim(),
      phone: form.phone.trim(),
      marketingOptIn: form.marketingOptIn,
    },
    locationId: selection.locationId,
    staffId: selection.staffId,
    serviceIds: selection.serviceIds,
    earliestDate: form.earliestDate,
    latestDate: form.latestDate,
    weekdays: form.weekdays.length > 0 ? form.weekdays : undefined,
    timeOfDay: form.timeOfDay,
    turnstileToken,
  };
}

/** The link the booking page's "join the waitlist" button points at. */
export function joinWaitlistHref(selection: {
  locationId: string;
  serviceIds: string[];
  date?: string;
  staffId?: string;
}): string {
  const params = new URLSearchParams({
    location: selection.locationId,
    services: selection.serviceIds.join(","),
  });
  if (selection.date) params.set("date", selection.date);
  if (selection.staffId) params.set("staff", selection.staffId);
  return `/waitlist/join?${params.toString()}`;
}
