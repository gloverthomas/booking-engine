# Booking Engine — Plan

A self-owned replacement for Timely, built for Ryan Kennedy Hairdressing (2 locations, 1 stylist, ~15-minute slot grid, 50% deposit at booking).

Status: **draft for review**. Nothing is built yet. Sections marked **VERIFY** rely on third-party facts that change often; check them against the vendor's own page before committing.

---

## 1. Goals and non-goals

**Goals (v1 = parity with what Ryan actually uses in Timely):**

1. Public booking flow: location → services → day/time → details → pay deposit → confirmation.
2. Take a **50% deposit at booking** (configurable) and save the card.
3. Charge / retain fees for **late cancellations and no-shows** within a configurable window (currently 24h).
4. Confirmation **email** (with invoice) and **SMS** confirmation + day-before reminder.
5. Admin portal: **calendar view**, bookings, clients, services, hours, reporting.
6. **Google Calendar** two-way sync.
7. **Xero**: contacts, invoices and payments pushed automatically.

**Non-goals for v1** (cheap to add later, expensive to build now): multi-tenant SaaS, multiple staff with separate logins, client accounts/passwords, marketing campaigns, gift cards, retail/products, packages/memberships, waitlist, native mobile apps.

**The success test:** Ryan can cancel Timely, and nothing he relies on stops working.

## 2. What the screenshots and invoice tell us

| Observation | Implication |
|---|---|
| 5 services (45m/$95, 15m/$30, 60m/$126, 20m/$45, 30m/$65), multi-select | Services have duration + price; a booking has 1..n services; total duration = sum |
| Slots every 15 min (2:30, 2:45, 3:00, 3:15) | Slot grid is configurable, default 15 min |
| 2 locations (Northside – Lola Fortune; Southside – High Barber) | Availability is **per location**; he likely works different days at each |
| Policy: "bookings may be moved 15min either side, not within 48h" | Admin needs a "shift booking" action that notifies the client |
| Policy: 50% deposit deducted from service; forfeited if cancelled < 24h | Deposit is real money collected up front; "forfeit" = simply don't refund |
| "Cash discount available" | Checkout screen needs payment method + discount; invoice must reflect it |
| Invoice #2564 shows an ABN, **tax N/A, $0.00 GST**, line "Deposit for Maintenance Haircut on <date>", payment type "TimelyPay" | Ryan is probably **not GST-registered** → Xero tax type must be "No GST / BAS Excluded", not 10% GST. **Confirm with him/his accountant.** |
| Timely invoices the *deposit* as its own tax invoice | Open question (§12): one invoice per booking with deposit applied as a part-payment is cleaner in Xero |
| Timely flow includes: Cloudflare Turnstile, phone OTP login, Facebook/Google login, "continue as guest", pronouns, other phone, company, comments, "booking for someone else", marketing opt-in, policy agreement | We keep the useful fields, drop the login wall (see §5) |
| Emails come from `noreply@gettimely.com`, SMS from a branded sender | We send from his own domain; SMS needs sender registration (§8) |

## 3. Recommended stack

One TypeScript codebase, one deployable, one database. Optimise for: cheap to run, one person can maintain it, boring technology.

| Concern | Choice | Why |
|---|---|---|
| Language / framework | **TypeScript + Next.js (App Router)** | One app serves the public booking pages, the admin portal and API routes; matches the existing tooling in this workspace |
| UI | Tailwind + Radix primitives (shadcn-style), **custom-themed to Ryan's brand** (peach/black, heavy grotesk) | Booking page should look like his site, not a template |
| Calendar UI | **FullCalendar** (MIT time-grid views) | Drag/drop, day/week views, mobile-capable; avoid its premium resource-timeline plugin |
| Database | **PostgreSQL** | Exclusion constraints prevent double-booking at the DB level (§6) |
| ORM / migrations | **Drizzle** | Typed, SQL-close, simple migrations |
| Admin auth | **Better Auth** (or Auth.js) with Google sign-in + owner allow-list | He's connecting Google anyway; no password to manage |
| Customer identity | **Guest checkout + signed magic links** for "view/change my booking" | No accounts, no passwords, no OTP cost |
| Background jobs | **pg-boss** (Postgres-backed queue) in a separate worker process | Reminders, retries, Xero sync, hold expiry; no extra SaaS |
| Payments | **Stripe** (PaymentElement, PaymentIntents, webhooks) on **Ryan's own Stripe account** | No Connect needed for single tenant; card data never touches us (PCI SAQ-A) |
| Email | **Resend** + React Email, sent from his domain (SPF/DKIM/DMARC), `.ics` attached | Cheap, good deliverability tooling |
| SMS | Provider-agnostic `SmsProvider` interface; start with **ClickSend** or **Twilio** (AU) | Swappable if price/deliverability disappoint |
| Calendar | **Google Calendar API** (OAuth, `events`, `freebusy`, push channels) | Two-way sync |
| Accounting | **Xero Accounting API** (OAuth2, `xero-node`) | Contacts, invoices, payments |
| Bot protection | **Cloudflare Turnstile** + per-IP/phone rate limits | Same as Timely, no user friction |
| Time handling | Store UTC, render in `Australia/Melbourne` with Temporal/Luxon | DST changes (Oct/Apr) are the classic scheduling bug |
| Testing | Vitest (unit), Playwright (E2E + visual), Stripe/Xero/Google sandboxes | Repo standards require 80%+ coverage and TDD |
| Observability | Sentry (free tier), structured logs, uptime ping | A silent booking outage costs money |
| Hosting | **Railway**: `web` + `worker` + Postgres in one project (~US$10–20/mo **VERIFY**) | Flat, cheap, long-running worker is trivial. Alternative: Vercel Pro + Neon (+ Inngest instead of pg-boss). Note Vercel Hobby is non-commercial, so it isn't free for this. |
| Backups | Daily automated Postgres backups + a weekly off-platform dump | Bookings and client history are the business's records |

**Single-tenant, but not sloppy:** one `business` row, `staff_id` and `location_id` on everything that needs them. Adding a second stylist later is a data change, not a rewrite. Adding other businesses (selling this as a product) is a bigger step and deliberately out of scope.

### Running cost target

Hosting ~US$10–20/mo + domain + SMS (~A$0.05–0.10 each, **VERIFY per provider**) + Stripe fees (online domestic cards ≈ 1.7% + 30c, reportedly lowered to ≈1.65% + 30c from 1 Oct 2026 — **VERIFY on Stripe's page**). Xero's new API **Starter tier** (free, 5 connections, 1,000 calls/day/org) is ample for one business — **VERIFY**.

## 4. System overview

```
                       ┌───────────────────────────┐
 Client browser ─────► │ Next.js web               │ ◄───── Ryan (phone/desktop PWA)
 (public booking)      │  /book  /manage/:token    │        /admin
                       │  /api/*  webhooks         │
                       └──────┬───────────┬────────┘
                              │           │ enqueue
                      ┌───────▼──┐   ┌────▼─────────┐
                      │ Postgres │◄──┤ Worker       │──► Resend (email)
                      │ (+queue) │   │ (pg-boss)    │──► SMS provider
                      └──────────┘   │              │──► Xero
                              ▲      │              │──► Google Calendar
        Stripe webhooks ──────┘      └──────────────┘
        Google push notifications ───►  (to web, then queue)
```

Rules that keep this reliable:

- **The booking is committed first; integrations are side-effects.** Email, SMS, Xero and Google never block or fail a booking. Each is a queued job with retries and visible status in the admin ("Xero: failed – retry").
- **Outbox pattern:** domain events are written in the same DB transaction as the state change, then fanned out to jobs.
- **Idempotency everywhere:** Stripe webhook events, Xero pushes and SMS sends carry idempotency keys so retries can't double-charge or double-send.

## 5. Booking flow (public)

Mirrors Timely's steps, minus the login wall:

1. **Location** (skipped if only one is bookable).
2. **Services** (multi-select, shows duration + price).
3. **Day & time** (month grid with availability dots; slots grouped Morning / Afternoon).
4. **Details**: first/last name, email, mobile, optional pronouns, other phone, company, comments, "booking for someone else", marketing opt-in (unticked by default), **cancellation policy checkbox**.
5. **Pay deposit** (Stripe PaymentElement incl. Apple Pay / Google Pay).
6. **Confirmation page** + email + SMS.

Decisions worth noting:

- **No account/OTP step.** The card payment already proves intent, and OTP costs an SMS per booking. Returning clients are recognised by a first-party cookie (prefill) or by email/phone match. Turnstile + rate limits handle abuse.
- **Store policy acceptance** (timestamp + policy version + IP) with the booking. This is the evidence needed if a late-cancel fee is ever disputed or charged back.
- **Slot hold:** picking a time creates a `pending_payment` booking that holds the slot for ~10 minutes; the Stripe webhook promotes it to `confirmed`. Unpaid holds expire via a job. This prevents the "two people paying for the same slot" race.
- **Embedding:** host at `book.<his-domain>`; embed in his existing site via iframe (auto-resizing) or just link the "Book now" button.

## 6. Core domain model

Tables (sketch):

- `business` (name, timezone, ABN, settings JSON: slot step, deposit %, cancel window hours, reminder offsets, tax mode)
- `location` (name, address, timezone, active)
- `staff` (name, google tokens ref, active)
- `service` (name, description, duration_min, price_cents, buffer_min, deposit_override_pct, active, sort)
- `service_location` / `service_staff` (who offers what where)
- `availability_rule` (staff, location, weekday, start, end) — recurring weekly hours
- `time_block` (staff, start, end, reason) — leave, appointments elsewhere, and imported Google busy time
- `client` (name, email, phone E.164, pronouns, notes, marketing_opt_in, stripe_customer_id, merged_into)
- `booking` (client, staff, location, `during tstzrange`, status, total_cents, deposit_cents, policy_accepted_at/version, booked_for_other, comments, source, hold_expires_at, gcal_event_id, xero_invoice_id)
- `booking_service` (booking, service snapshot of name/duration/price at booking time)
- `payment` (booking, kind: deposit | balance | no_show_fee | refund, method: stripe | cash | eftpos | other, amount, stripe ids, status)
- `message_log` (booking/client, channel, template, provider id, status, error)
- `integration_account` (provider: google | xero | stripe, encrypted tokens, tenant id, status, last_sync)
- `job`/outbox tables (pg-boss owns its own schema)
- `audit_log` (who changed what, when)

**Status machine:**

```
pending_payment ─► confirmed ─► completed
      │               ├─► cancelled_by_client   (outside window → refund/credit)
      ▼               ├─► late_cancelled        (inside window → deposit kept, optional extra fee)
   expired            ├─► cancelled_by_staff    (always refund)
                      └─► no_show               (deposit kept, optional extra fee)
```

**Double-booking protection** is a database guarantee, not just app logic:

```sql
CREATE EXTENSION IF NOT EXISTS btree_gist;
ALTER TABLE booking ADD CONSTRAINT no_overlap
  EXCLUDE USING gist (staff_id WITH =, during WITH &&)
  WHERE (status IN ('pending_payment','confirmed'));
```

**Availability engine** (pure function, heavily unit-tested): weekly rules for the location → minus time blocks → minus existing bookings (+ buffers) → minus Google busy time → minus "too soon"/"too far ahead" limits → sliced on the slot grid for the total duration of the selected services. Test DST transition days explicitly.

## 7. Payments: deposit, cancellations, no-shows

Ryan's policy maps cleanly onto Stripe:

- **At booking:** create a PaymentIntent for the deposit (50% of total, rounded) with `setup_future_usage: 'off_session'` so the card is saved on his Stripe Customer with the consent text shown.
- **Cancel/reschedule outside the window (≥24h):** free. Refund deposit (or move it to the new time on reschedule). Configurable: refund vs credit. Note Stripe generally doesn't return its processing fee on refunds.
- **Cancel inside the window:** deposit is **kept** (no new charge needed) — this is the policy as written. Optionally charge an additional fee off-session using the saved card (configurable amount/percentage).
- **No-show:** admin clicks "No-show" → keeps deposit, optional off-session charge for the remainder or a fixed fee. Off-session charges can still need customer authentication; build the "payment failed → send pay-link by SMS" fallback.
- **Balance at the appointment:** admin "Check out" screen records method (cash / EFTPOS / other / Stripe link), applies a **cash discount** if configured, and closes the booking. Taking the balance by card later (Stripe Terminal / Tap to Pay) is a possible v2.
- **Webhooks are the source of truth** (`payment_intent.succeeded`, `charge.refunded`, `charge.dispute.created`, etc.), verified and deduplicated.
- **Chargebacks:** surface disputes in the admin; keep policy acceptance + message logs as evidence.

## 8. Notifications

| Message | Channel | Trigger |
|---|---|---|
| Booking confirmation + invoice PDF + `.ics` | Email + SMS | On `confirmed` |
| Reminder (day before; Timely's text mentions arrive-early/parking/cash discount) | SMS (+ email optional) | `start − 24h`, scheduled when confirmed, **cancelled/re-timed on reschedule or cancel** |
| Booking moved / cancelled | Email + SMS | Admin or client change |
| Late-cancel / no-show fee charged | Email | Payment event |
| New booking / cancellation alert to Ryan | Push (PWA) or SMS | On event |

- Templates are editable in admin (with variables) and versioned.
- **SMS sender ID:** Australia requires **alphanumeric sender IDs to be registered** (ACMA SMS Sender ID Register; enforcement reported from **1 July 2026**, needs an ABN — **VERIFY**). Unregistered IDs show as "Unverified". Start registration through the chosen SMS provider early — it has lead time. Using a plain mobile number/long code avoids the register but looks less branded.
- **Spam Act:** transactional messages (confirm/remind) are fine; any marketing needs consent + unsubscribe. Keep the marketing opt-in separate and unticked.
- **Email deliverability:** configure SPF/DKIM/DMARC on his domain before launch; test into Gmail/iCloud/Outlook.

## 9. Admin portal

Mobile-first **PWA** (Ryan will mostly use his phone between clients), with a strong desktop layout.

- **Calendar:** day / week / (3-day on mobile); click to create, drag to move, resize, colour by status/location; block time; location filter; Google-busy overlay.
- **Booking drawer:** client, services, notes, payment status, timeline of messages/payments, actions: Move (with "notify client"), Cancel (with refund/forfeit choice), No-show, Check out, Resend confirmation.
- **Clients:** search, history, notes (e.g. cut formula, preferences), no-show count, merge duplicates, CSV export/import.
- **Catalogue:** services (price, duration, buffer, deposit override), per-location offering.
- **Availability:** weekly hours per location, exceptions, time off, booking limits (min notice, max horizon, slot step).
- **Settings:** deposit %, cancel window, fee rules, policy text (versioned), message templates, branding.
- **Integrations:** Stripe, Google, Xero, SMS status + reconnect + failed-sync queue.
- **Reports:** see below.
- **Roles:** owner only in v1; schema ready for `staff`/`receptionist` later.

### Reporting (Timely parity, in priority order)

1. Revenue by day/week/month/location/service (gross, deposits, balance, refunds, fees kept).
2. Bookings: count, utilisation (booked hours ÷ available hours), busiest days/times.
3. Cancellations, late cancels, no-shows (+ $ recovered).
4. Clients: new vs returning, retention/rebook rate, top clients, lapsed clients.
5. Outstanding balances and Stripe payouts vs Xero reconciliation status.
6. CSV export on every table.

## 10. Integrations

### Google Calendar (two-way)
- **Out:** each confirmed booking → event on Ryan's chosen calendar (title, client, services, location, phone, link to admin). Update/delete on change.
- **In:** read busy time (`freebusy` + `events.watch` push channels with a `syncToken` fallback poll) → `time_block` entries so personal events block availability. Ignore events we created.
- **Gotcha:** an OAuth app left in **"Testing"** has refresh tokens that expire after 7 days. Publish the consent screen to **"In production"** (single user, so unverified-app warning is fine) and re-consent once afterwards. **VERIFY** against Google's docs.
- **Bonus:** the same sync makes the **Timely → this system cutover safe** (§13): both systems read the same calendar and so respect each other's bookings.

### Xero
- OAuth2 authorisation-code flow with `offline_access`. Apps created after 2 March 2026 must use **granular scopes** (`accounting.contacts`, `accounting.invoices`, `accounting.payments`, plus `accounting.settings.read` to read accounts/tax rates) rather than `accounting.transactions` — **VERIFY**.
- **Flow per booking (proposed):**
  1. Upsert Xero **Contact** (match on email).
  2. Create **ACCREC invoice** for the service total (line per service, tax type "No GST" until confirmed otherwise; our booking id in `Reference`; sequence/number per Xero).
  3. Record the **deposit Payment** against it into a "Stripe clearing" account (not the bank).
  4. At checkout, record the **balance Payment** (cash/EFTPOS/Stripe) or a discount line.
  5. Refunds → credit note + refund; forfeited deposit stays as revenue.
  6. Fetch the invoice **PDF** from Xero (`Accept: application/pdf`) to attach to the client email.
- **Stripe fees & payouts:** Stripe pays out net batches, so bank reconciliation in Xero is messy. Either book fee/payout lines ourselves from Stripe balance transactions, or use Stripe's own Xero app for payout reconciliation and let our integration own invoices/payments only. Ask his bookkeeper which they prefer.
- Use the Xero **Demo Company** for development. Failures go to a visible retry queue; Xero never blocks booking or the confirmation email (invoice follows if not ready in time).

## 11. Security, privacy, compliance

- Secrets only in env vars/secret manager; **the GitHub repo is currently public** — never commit `.env`, exports, or client data; consider making it private.
- Encrypt integration tokens at rest; scope Stripe/Xero/Google access minimally; rotate on exposure.
- Admin: Google sign-in with owner allow-list, session hardening, CSRF protection, rate limiting, audit log. Magic-link tokens: signed, single-purpose, expiring, rate-limited.
- Strict CSP, security headers, input validation at every boundary (zod), parameterised queries only.
- PCI: Stripe Elements keeps us at SAQ-A. We never store PAN.
- **Privacy Act / APPs:** collect only what's needed, privacy policy link at booking, deletion/export on request, retention policy for client data and message logs, no PII in logs or analytics.
- Data portability: full CSV/JSON export so Ryan is never locked in again.

## 12. Open questions for Ryan (and his accountant)

1. **GST:** is he registered? (Invoice suggests no.) Determines Xero tax type and invoice wording ("Tax invoice" vs "Invoice").
2. **Invoice model:** deposit invoice + separate balance invoice (as Timely does), or one invoice per booking with the deposit applied as a payment?
3. **Deposit rules:** 50% for every service, including a $30 beard trim? Any services exempt?
4. **Refund policy outside the window:** full refund, or credit towards a rebooking?
5. **No-show fee:** keep deposit only, or charge the remainder / a fixed fee?
6. **Cash discount:** how does it work (percentage off the total? only for the balance)?
7. **Schedule:** working days/hours per location; breaks; how far ahead can clients book; minimum notice.
8. **Volume:** roughly how many bookings/week and clients in Timely (sizes the migration).
9. **Accounts:** does he already have his own Stripe account, a Xero org, a Google Workspace/Gmail calendar, and a domain he controls?
10. **SMS sender:** branded "Ryan Kennedy" sender ID (needs registration) or a plain mobile number?
11. **Who owns it?** He should own the Stripe/Xero/Google/SMS/hosting accounts; this repo is the code. Decide who handles support when something breaks on a Saturday.

## 13. Delivery plan

Sizes: S ≈ a few days, M ≈ ~1 week, L ≈ 2+ weeks of focused work. Rough total for v1: **~8–12 weeks part-time**; the order matters more than the estimate.

| # | Milestone | Size | Exit criteria |
|---|---|---|---|
| 0 | **Foundations**: repo, CI (lint/type/test), env/secrets, Postgres + Drizzle, deploy skeleton (web + worker), Sentry, admin auth | S | Hello-world deployed with login; CI green |
| 1 | **Domain + availability engine** (pure, test-first): rules, blocks, buffers, DST | M | Property/unit tests incl. DST; exclusion constraint proven by test |
| 2 | **Public booking flow** (no payment): all steps, holds, Turnstile, brand styling, seed his real services/locations | M | Can book end-to-end on staging; Playwright E2E + screenshots at 320/768/1024/1440 |
| 3 | **Stripe deposit** + webhooks + hold expiry + **confirmation email** (+ ICS) | M | Real test-mode payment confirms a booking; refunds work; no double-bookings under concurrent test |
| 4 | **Admin portal core**: calendar, booking drawer, clients, services, hours, time off | L | Ryan can run a day from his phone on staging |
| 5 | **Cancel/reschedule/no-show + fee logic** + magic-link "manage my booking" | M | Every policy branch covered by tests and a manual script |
| 6 | **SMS**: provider adapter, confirmation, reminders (reschedule-safe), message log; start sender-ID registration in M0/M1 | M | Reminder fires at T−24h and is cancelled on reschedule |
| 7 | **Google Calendar** two-way sync | M | Personal event blocks slots; bookings appear as events; no echo loops |
| 8 | **Xero** sync (contacts, invoices, payments, PDF) + retry queue | M–L | Demo Company reconciles; failed pushes retry and surface |
| 9 | **Reports** | M | Numbers match Stripe/Xero for a test month |
| 10 | **Migration + parallel run + cutover**: import Timely client CSV, run both systems against the shared Google Calendar for 2–4 weeks, swap the website embed, then cancel Timely | M | Zero missed/double bookings during parallel run; Ryan signs off |
| 11 | **Hardening**: load test, security review, backup/restore drill, accessibility audit, runbook | S–M | Restore drill passed; a11y checks clean |

**Cutover safety:** keep Timely live until the parallel run proves the new system. Existing future Timely bookings stay in Timely (visible via the shared Google Calendar); new ones go to the new system. Don't try to migrate in-flight deposits.

## 14. Main risks

| Risk | Mitigation |
|---|---|
| Booking outage or bug costs real money | Parallel run, Sentry + uptime alerts, simple rollback (re-point embed to Timely) |
| Double-booking | DB exclusion constraint + holds + concurrency tests |
| Timezone/DST errors | UTC storage, Temporal/Luxon, explicit DST tests |
| SMS not delivered / "Unverified" sender | Register sender ID early, provider adapter, delivery status in message log |
| Email to spam | SPF/DKIM/DMARC, dedicated sending domain, seed-list testing |
| Google refresh token expiry | Publish consent screen; surface "reconnect" in admin |
| Xero API/scopes/pricing churn | Granular scopes from day 1; isolate behind an adapter; free Starter tier covers one org |
| Late-fee disputes/chargebacks | Stored policy acceptance, clear UX, message logs |
| Key-person risk (one developer) | Docs, runbook, standard stack, owner-held accounts |
| Scope creep ("Timely also does…") | v1 = parity checklist in §1; everything else goes to a backlog |

## 15. Immediate next steps

1. Review this plan and settle the §12 questions with Ryan (1–5 and 9 block design decisions).
2. Decide public vs private repo, then initialise it (`gloverthomas/booking-engine` is empty today).
3. Kick off the long-lead items in parallel: SMS provider + sender-ID registration, Stripe/Xero/Google developer apps, domain/DNS for email.
4. Start Milestone 0, then Milestone 1 test-first.

## Appendix A — seed data (from the current booking page)

Locations: **Northside (Lola Fortune)**, 302 Rathdowne Street, Carlton North VIC 3054 · **South side (High Barber)**, 249 High Street, Prahran VIC 3181 (listed as "Stonnington").

Services: Maintenance Haircut (45 min, $95) · Beard Trim (15 min, $30) · Restructure/Restyle (1 h, $126) · Bang Trim (20 min, $45) · Clipper Back And Sides Freshen Up (30 min, $65).

Policy text to carry over (versioned): 24h notice for changes/cancellations; 50% booking fee deducted from the service and forfeited on late cancellation; late arrivals may be cancelled with deposit forfeited; bookings may be moved ±15 min (not within 48h of the appointment, with notice).
