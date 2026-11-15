/**
 * What an import file can contain, and the header names we recognise for each field. Timely's real
 * column names are not published, so detection is a best guess; the admin can always re-point a field
 * at any column (see ColumnMap).
 */

export type ClientField =
  | "ref"
  | "firstName"
  | "lastName"
  | "fullName"
  | "email"
  | "phone"
  | "notes"
  | "marketingOptIn"
  | "blocked"
  | "createdAt";

export type AppointmentField =
  | "ref"
  | "clientRef"
  | "clientName"
  | "clientFirstName"
  | "clientLastName"
  | "clientEmail"
  | "clientPhone"
  | "service"
  | "staff"
  | "location"
  | "date"
  | "startTime"
  | "endTime"
  | "start"
  | "end"
  | "duration"
  | "status"
  | "price"
  | "deposit"
  | "notes";

export type ImportKind = "clients" | "appointments";

/** field -> the header (as it appears in the file) it is read from, or null when not present. */
export type ColumnMap<F extends string> = Record<F, string | null>;

export const CLIENT_ALIASES: Record<ClientField, string[]> = {
  ref: ["id", "customerid", "clientid", "customernumber", "clientnumber", "customerref"],
  firstName: ["firstname", "first", "givenname", "forename"],
  lastName: ["lastname", "last", "surname", "familyname"],
  fullName: ["name", "fullname", "customername", "clientname", "customer", "client"],
  email: ["email", "emailaddress", "e-mail", "customeremail", "clientemail"],
  phone: [
    "mobile",
    "mobilephone",
    "mobilenumber",
    "phone",
    "phonenumber",
    "cell",
    "cellphone",
    "contactnumber",
    "telephone",
  ],
  notes: ["notes", "note", "clientnotes", "customernotes", "comments", "comment", "medicalnotes"],
  marketingOptIn: [
    "marketing",
    "marketingoptin",
    "acceptsmarketing",
    "emailmarketing",
    "smsmarketing",
    "optin",
    "subscribed",
    "receivemarketing",
    "marketingconsent",
    "marketingpreference",
  ],
  blocked: ["blocked", "isblocked", "banned", "blacklisted"],
  createdAt: ["created", "createdat", "datecreated", "joined", "firstvisit", "customersince"],
};

export const APPOINTMENT_ALIASES: Record<AppointmentField, string[]> = {
  ref: [
    "id",
    "appointmentid",
    "bookingid",
    "reference",
    "ref",
    "appointmentnumber",
    "bookingreference",
  ],
  clientRef: ["customerid", "clientid", "customernumber", "clientnumber"],
  clientName: ["customer", "customername", "client", "clientname", "name", "fullname"],
  clientFirstName: ["customerfirstname", "clientfirstname", "firstname"],
  clientLastName: ["customerlastname", "clientlastname", "lastname", "surname"],
  clientEmail: ["email", "customeremail", "clientemail", "emailaddress"],
  clientPhone: [
    "mobile",
    "phone",
    "customermobile",
    "clientphone",
    "customerphone",
    "mobilenumber",
    "phonenumber",
  ],
  service: [
    "service",
    "services",
    "servicename",
    "treatment",
    "item",
    "servicestaken",
    "servicetype",
  ],
  staff: ["staff", "staffmember", "employee", "stylist", "provider", "practitioner", "staffname"],
  location: ["location", "venue", "site", "branch", "salon", "locationname"],
  date: ["date", "appointmentdate", "startdate", "day", "bookingdate"],
  startTime: ["starttime", "start", "time", "timefrom", "from", "begins"],
  endTime: ["endtime", "end", "timeto", "to", "finish", "finishtime", "ends"],
  start: [
    "startdatetime",
    "datetime",
    "starts",
    "startat",
    "appointmentstart",
    "appointmentdatetime",
  ],
  end: ["enddatetime", "endat", "appointmentend"],
  duration: [
    "duration",
    "durationmins",
    "minutes",
    "length",
    "durationminutes",
    "mins",
    "servicetime",
  ],
  status: ["status", "appointmentstatus", "state", "bookingstatus"],
  price: [
    "price",
    "total",
    "amount",
    "totalprice",
    "cost",
    "revenue",
    "servicevalue",
    "value",
    "grosstotal",
  ],
  deposit: [
    "deposit",
    "depositpaid",
    "prepaid",
    "amountpaid",
    "paidamount",
    "paid",
    "depositamount",
    "timelypay",
  ],
  notes: ["notes", "note", "appointmentnotes", "comments", "comment", "customernotes"],
};

const norm = (header: string) => header.toLowerCase().replace(/[^a-z0-9-]/g, "");

/**
 * Map each field to the first unused header whose normalised name matches one of its aliases. Fields
 * are tried in the order given by `priority`, so a header like "Name" goes to the field that needs it most.
 */
export function autoMap<F extends string>(
  headers: readonly string[],
  aliases: Record<F, string[]>,
  priority: readonly F[],
): ColumnMap<F> {
  const used = new Set<string>();
  const map = Object.fromEntries(
    (Object.keys(aliases) as F[]).map((f) => [f, null]),
  ) as ColumnMap<F>;
  const normalised = headers.map((h) => [h, norm(h)] as const);

  for (const field of priority) {
    for (const alias of aliases[field]) {
      const hit = normalised.find(([h, n]) => n === alias && !used.has(h));
      if (hit) {
        map[field] = hit[0];
        used.add(hit[0]);
        break;
      }
    }
  }
  return map;
}

export const CLIENT_PRIORITY: readonly ClientField[] = [
  "ref",
  "email",
  "phone",
  "firstName",
  "lastName",
  "fullName",
  "marketingOptIn",
  "blocked",
  "createdAt",
  "notes",
];

export const APPOINTMENT_PRIORITY: readonly AppointmentField[] = [
  "ref",
  "clientRef",
  "clientEmail",
  "clientPhone",
  "clientFirstName",
  "clientLastName",
  "service",
  "staff",
  "location",
  "start",
  "end",
  "date",
  "startTime",
  "endTime",
  "duration",
  "status",
  "price",
  "deposit",
  "clientName",
  "notes",
];

export const autoMapClients = (headers: readonly string[]) =>
  autoMap(headers, CLIENT_ALIASES, CLIENT_PRIORITY);
export const autoMapAppointments = (headers: readonly string[]) =>
  autoMap(headers, APPOINTMENT_ALIASES, APPOINTMENT_PRIORITY);
