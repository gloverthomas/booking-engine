import { z } from "zod";

export interface ImportIssue {
  /** 1-based spreadsheet row (the header is row 1). */
  row: number;
  level: "error" | "warning";
  message: string;
}

export const importOptionsSchema = z.object({
  defaultStaffId: z.uuid().optional(),
  defaultLocationId: z.uuid().optional(),
  /** normalised name in the file -> staff id */
  staffMap: z.record(z.string(), z.uuid()).default({}),
  locationMap: z.record(z.string(), z.uuid()).default({}),
  /** normalised service name in the file -> service id, or null to keep it as free text */
  serviceMap: z.record(z.string(), z.uuid().nullable()).default({}),
  includePast: z.boolean().default(true),
  includeCancelled: z.boolean().default(false),
  /** Record the unpaid remainder of completed past bookings as a legacy balance payment. */
  recordBalance: z.boolean().default(false),
  /** Queue the day-before reminder for imported future bookings. Never sends a confirmation. */
  sendReminders: z.boolean().default(false),
});
export type ImportOptions = z.infer<typeof importOptionsSchema>;

/** What the planner needs to know about the database. Loaded once per run. */
export interface Catalog {
  businessId?: string;
  zone: string;
  now: Date;
  locations: Array<{ id: string; name: string }>;
  staff: Array<{ id: string; name: string }>;
  services: Array<{ id: string; name: string; durationMin: number; priceCents: number }>;
  clients: Array<{
    id: string;
    firstName: string;
    lastName: string;
    email: string | null;
    phone: string | null;
    externalRef: string | null;
  }>;
  bookingRefs: ReadonlySet<string>;
  /** Slot-holding bookings that already exist, for overlap checks. */
  heldBookings: Array<{ staffId: string; start: Date; end: Date }>;
}

export interface ClientValues {
  firstName: string;
  lastName: string;
  email: string | null;
  phone: string | null;
  notes: string | null;
  marketingOptIn: boolean;
  blocked: boolean;
  createdAt: Date | null;
}

export type ClientOpAction = "create" | "link" | "unchanged" | "skip";

export interface ClientOp {
  row: number;
  action: ClientOpAction;
  externalRef: string | null;
  existingId?: string;
  values: ClientValues;
}

export type ClientTarget =
  | { kind: "existing"; id: string }
  | { kind: "new"; key: string; externalRef: string | null; values: ClientValues };

export interface BookingLine {
  serviceId: string | null;
  name: string;
  durationMin: number;
  priceCents: number;
}

export type ImportedBookingStatus = "confirmed" | "completed" | "cancelled_by_staff" | "no_show";

export interface BookingOp {
  row: number;
  action: "create" | "unchanged" | "skip";
  externalRef: string;
  client: ClientTarget;
  staffId: string;
  locationId: string;
  start: Date;
  end: Date;
  status: ImportedBookingStatus;
  totalCents: number;
  depositCents: number;
  balanceCents: number;
  lines: BookingLine[];
  notes: string | null;
}

/** A name in the file that matched nothing. `key` is what option maps are keyed by. */
export interface UnmappedName {
  key: string;
  name: string;
  rows: number;
}

export interface Unmapped {
  staff: UnmappedName[];
  locations: UnmappedName[];
  services: UnmappedName[];
}

export interface PlanSummary {
  total: number;
  create: number;
  link: number;
  unchanged: number;
  skip: number;
  errors: number;
  warnings: number;
}
