/** Plain-English names for the fields an import file can fill. */
export const FIELD_LABELS: Record<string, string> = {
  ref: "Record ID",
  firstName: "First name",
  lastName: "Last name",
  fullName: "Full name",
  email: "Email",
  phone: "Mobile",
  notes: "Notes",
  marketingOptIn: "Marketing opt-in",
  blocked: "Blocked",
  createdAt: "Client since",
  clientRef: "Client ID",
  clientName: "Client name",
  clientFirstName: "Client first name",
  clientLastName: "Client last name",
  clientEmail: "Client email",
  clientPhone: "Client mobile",
  service: "Service",
  staff: "Stylist",
  location: "Location",
  date: "Date",
  startTime: "Start time",
  endTime: "End time",
  start: "Start (date and time together)",
  end: "End (date and time together)",
  duration: "Duration",
  status: "Status",
  price: "Total price",
  deposit: "Deposit paid",
};

export const label = (field: string) => FIELD_LABELS[field] ?? field;

export interface Choice {
  id: string;
  name: string;
}

export interface WizardOptions {
  defaultStaffId: string;
  defaultLocationId: string;
  staffMap: Record<string, string>;
  locationMap: Record<string, string>;
  serviceMap: Record<string, string | null>;
  includePast: boolean;
  includeCancelled: boolean;
  recordBalance: boolean;
  sendReminders: boolean;
}

export const DEFAULT_OPTIONS: WizardOptions = {
  defaultStaffId: "",
  defaultLocationId: "",
  staffMap: {},
  locationMap: {},
  serviceMap: {},
  includePast: true,
  includeCancelled: false,
  recordBalance: false,
  sendReminders: false,
};

/** The request body: empty strings become "not set" so the server's uuid checks pass. */
export function toRequestOptions(o: WizardOptions) {
  return {
    ...o,
    defaultStaffId: o.defaultStaffId || undefined,
    defaultLocationId: o.defaultLocationId || undefined,
  };
}
