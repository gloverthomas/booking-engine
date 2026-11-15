# Moving from Timely

How to bring Ryan's clients and already-booked appointments across, and how to cut over without double
bookings or surprise messages. The importer lives at **Import** in the admin menu (owner only).

**Not yet seen**: a real Timely export. The importer detects columns by their header names and lets you
re-point any field by hand, so a different layout costs a few clicks, not code. Send a headers-only export
(delete every row but the first) and we can tune the detection to Timely's actual names.

## What gets imported

| Data                   | Becomes                      | Notes                                                                                                                                                         |
| ---------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Clients                | Clients                      | Matched to existing clients by Timely ID, then email, then mobile. Never overwrites details already here. Marketing opt-in is only set when the file says so. |
| Future appointments    | Confirmed bookings           | Keep their stylist, time and services. Block the slot like any booking.                                                                                       |
| Past appointments      | Completed bookings (history) | Optional (on by default). Past rows marked booked become completed.                                                                                           |
| Cancelled appointments | Cancelled                    | Optional (off by default).                                                                                                                                    |
| Deposits already paid  | A "legacy" payment           | Method `other`, tagged `legacy`, so reports show the deposit without pretending Stripe took it.                                                               |

Every imported record carries `external_ref = timely:<id>` and bookings carry `source = import:timely`.
That is what makes a re-run safe: a row already imported is reported as "already imported" and left alone.
A file with no ID column gets a stable ID from client, time and stylist, so it is also safe to repeat.

## What an import never does

- **Sends nothing.** No confirmation email or text. The clients already have one from Timely. The only
  optional message is the usual day-before reminder, off by default (a checkbox).
- **Touches nothing in Xero.** Their invoices are already in the old system, so imported bookings are
  ignored by the Xero sync: no invoices, payments or credit notes.
- **Writes nothing to Google Calendar.** The appointments are already there from Timely's own sync.

## Before you start

1. The catalogue is set up here: services (names matching Timely's as closely as possible), stylists and the
   location. Appointments are matched by name; anything unmatched is kept as free text with the file's price
   and duration, and listed so you can see it.
2. Ryan is signed in as owner.

## Steps

1. **Export from Timely.** Clients as a CSV. Appointments as a CSV covering today onward, plus any history
   you want. Include, if Timely offers them: appointment ID, client (name, email, mobile or client ID),
   service, staff, date and start time (or end time or duration), status, price, deposit paid, notes.
2. **Import clients first.** Import, choose "Clients", pick the file. Check the columns the importer chose,
   read the problems list, then tick the confirmation and import.
3. **Import appointments.** Same screen, choose "Appointments". Set the stylist and location to use when the
   file has none. Map any stylist or location names it could not match. Read the problems list: overlaps,
   unknown stylists and unreadable dates are listed by row.
4. **Fix and repeat.** Correct the file or the mapping and run it again. Rows already imported stay as they
   are; only the new or fixed ones are added.

Each change re-checks the file as a dry run that writes nothing. Nothing is saved until you tick the box and
press Import.

## What does not carry over

- **Saved cards.** They live with Timely's payment processor and are not part of an export; assume they do
  not move (ask Timely support). Imported clients have no card on file here, so a late-cancel or no-show
  fee on an imported booking cannot be charged automatically. Collect it by hand. Clients get a saved card
  here the next time they book online.
- **Refunds of legacy deposits.** Cancelling an imported booking here records the deposit refund in the
  ledger but cannot move the money, because Stripe never took it. Return it through Timely's processor.
- **Loyalty, gift vouchers, packages, stock, marketing history.** Not built or not imported.

## Cutover

1. Agree a date. Import everything the day before.
2. On the day, run a **final import** of the appointments file to pick up bookings made since. Re-runs add
   only what is new.
3. Turn **off** Timely's Google Calendar sync and its online booking page, then connect Google here
   (Integrations). If both stay on, the two systems write to the same calendar.
4. Point the booking link (website, Instagram bio, Google Business Profile) to the new booking page.
5. Keep Timely read-only for a few weeks for lookups, then cancel it.

## Check afterwards

- Row counts: rows in the file = created + already imported + listed problems.
- Open the calendar for the next two weeks and spot-check ten bookings against Timely: stylist, time,
  services, price, deposit.
- Open three clients with several appointments and confirm they are one person, not duplicates.
- Confirm nothing was sent: an import writes no `message_log` rows (with reminders left off, a client
  should not hear from us until their normal reminder or a change you make).

## Undo

There is no undo button. Everything imported is tagged (`source = import:timely`,
`external_ref LIKE 'timely:%'`), so a purge is a single scripted job, but it is not built; ask before
importing a large file you are unsure of, and use the dry run.
