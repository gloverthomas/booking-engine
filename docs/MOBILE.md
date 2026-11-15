# Mobile app: the stylist's iPhone app

> **Status (built, not yet run on a device).** The app is in
> [booking-engine-mobile](https://github.com/gloverthomas/booking-engine-mobile) (Expo SDK 58) and talks to
> the staff API in `docs/API.md`. Built and tested: Google sign-in, Today, appointment detail (cancel,
> no-show, mark paid), create appointment, clients, **Tap to Pay** (server side and app), **push
> notifications**. Everything is covered by automated tests, but **none of it has been run on an iPhone**:
> that needs the accounts in section 5. Not built: reschedule UI, roster, clock in and out, waitlist,
> a generated OpenAPI document. The plan below is the original; section 7 records what was decided.

Repo for the app: <https://github.com/gloverthomas/booking-engine-mobile> (empty today). This file is the plan;
the backend work it needs lands in this repo.

Goal: Ryan and his stylists run the day from an iPhone. See the roster, create and cancel appointments on
the fly, take payment with **Tap to Pay on iPhone**, and get notified. Customers keep using the web booking
flow and the emailed manage link.

## 1. What exists today (checked against the code)

| Question                                          | Answer                                                                                                                                                                                                                                                                                                                                                                                            |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Are the web app's capabilities available as APIs? | **Customer side: yes.** `/api/public/*` is JSON over HTTP (catalog, availability, holds, bookings by manage token, waitlist). **Admin side: no.** Every admin operation is a Next.js server action (13 `actions.ts` files), which only works from the web app's own pages. A native app cannot call them.                                                                                         |
| Is the logic reusable?                            | **Yes.** The real work lives in plain functions under `src/server/**` (`booking/cancel`, `create-hold`, `reschedule`, `reassign`, `roster`, `waitlist`, `payments`, `timesheets`) and the server actions are thin wrappers. A REST layer over the same functions is mostly plumbing.                                                                                                              |
| MCP endpoint?                                     | `/api/mcp` exposes tools to Claude with a static bearer token. It is for Claude, not a mobile API.                                                                                                                                                                                                                                                                                                |
| Staff sign-in                                     | Better Auth, **Google sign-in only** (no passwords). Allowed: emails in `OWNER_EMAILS` plus active staff emails. Roles (owner, manager, stylist, reception) decide what each person can do (`requireAccess(permission)`). Sessions are cookies; a deactivated person cannot get a new session.                                                                                                    |
| Reusable for the app?                             | **Same identities and roles, different transport.** Cookies do not suit a native app. Better Auth 1.7.23 ships a `bearer` plugin (installed); `@better-auth/expo` is a separate package. Plan: native Google sign-in gives an ID token, the server exchanges it for a bearer session, through the same allow-list and session rules. Ryan uses the same Google account in the app and on the web. |
| Customer accounts                                 | **Not built, deliberately.** Customers are guests: name, email and mobile at booking, matched to a client record, with a signed manage link in their emails. There is no customer login. The app does not need one.                                                                                                                                                                               |
| In-person payments                                | **Schema only.** `payment.method = stripe_in_person` exists and `bookingId` is nullable so a tap can arrive before it is matched. No Terminal code, no connection-token endpoint, no webhook handling for card-present payments yet.                                                                                                                                                              |
| Push notifications                                | **Not built.** Today's staff alerts are email and SMS.                                                                                                                                                                                                                                                                                                                                            |

## 2. Stack

**Expo (React Native, TypeScript).** Reasons: same language as this repo so request and response types can be
generated once and shared; Stripe's Terminal **React Native SDK supports Tap to Pay on iPhone** (confirmed in
Stripe's docs); EAS Build gets TestFlight builds without a local Xcode dance. Constraint: Tap to Pay needs a
native module, so it is an Expo **development build**, never Expo Go.

Alternative: native Swift with the Terminal iOS SDK. More control, but a second language, nothing shared, and
slower. Only worth it if the React Native Terminal SDK proves flaky in testing; the plan keeps payments behind
one module boundary so that swap stays possible.

## 3. Features

**v1: the day**

- **Today and week roster**: Ryan sees everyone, a stylist sees only their own (existing `seesAllStaff`).
  Day list first, calendar grid second.
- **Booking detail**: client, services, price, deposit paid, balance due, notes, intake answers, tap-to-call
  and tap-to-text, mark complete, no-show.
- **Create on the fly**: search or create a client, pick services, pick a stylist and time from live
  availability (the same engine as the web), choose "deposit already taken", "collect now" or "no deposit".
  Walk-ins are first class.
- **Cancel and reschedule** with the fee choice made explicit: waive, or charge the late-cancel fee to the
  saved card (existing policy logic), with the client told automatically.
- **Take payment**: from a booking, show balance due, tap, receipt by SMS or email. Also a quick sale with no
  booking. Refunds stay on the web in v1.
- **Notifications** (push): new booking, cancellation, waitlist slot claimed, failed fee charge, payment
  received, and a morning summary. Per person, per type on or off.
- **Clock in and out** for timesheets (the web already has the widget).

**Later**: waitlist offer from the phone, client history and notes editing, PIN or Face ID lock for a shared
phone (`staff.pinHash` already exists), offline read of today's bookings, home-screen widget, reports.

**Not in the app**: catalog, settings, staff and integrations management, imports, reports. They stay on the
web.

**Limits to know**: Tap to Pay needs an iPhone XS or later on a current iOS; Stripe's docs list tipping as
unsupported on Tap to Pay readers, so no tip screen; very large contactless amounts may need a PIN.

## 4. Backend work in this repo (the critical path)

1. **`/api/v1` REST layer** over the existing `src/server` functions, each call going through the same
   `requireAccess(permission)` checks and audit actors the web uses. Resources: `me`, `bookings` (list by
   range, get, create, cancel, reschedule, reassign, complete, no-show), `availability`, `clients` (search,
   create, get), `catalog`, `roster`, `timesheets` (clock), `waitlist`, `payments`, `devices`.
2. **Contract once**: zod schemas (zod 4 can emit JSON Schema) produce an OpenAPI document; the mobile repo
   generates its client from it, so types never drift and nobody hand-writes fetch calls.
3. **Mobile auth**: Better Auth `bearer` plugin, Google ID-token exchange, short-lived access token plus
   refresh, revoke on logout and when a person is deactivated, rate limits, `trustedOrigins` for the app.
4. **Terminal**: `POST /payments/terminal/connection-token`, a Stripe Terminal Location for the salon address,
   `POST /bookings/:id/checkout` that creates a card-present PaymentIntent for the balance (amount decided on
   the server), and webhook handling that records `payment_intent.succeeded` for card-present payments as
   `stripe_in_person`, linked to the booking, idempotent like the existing webhook. Unmatched taps stay
   orphaned for the owner to match.
5. **Push**: a `device_token` table, register and unregister endpoints, a new `consumer.push` queue off the
   outbox (same pattern as the other consumers), per-person preferences, Expo push service with receipt
   handling for dead tokens.
6. **Tests**: every route has permission tests (a stylist cannot read another stylist's bookings), plus
   contract tests against the OpenAPI document.

## 5. Accounts and lead times (start these first, they are waiting time, not work)

- **Apple Developer Program** in Ryan's name (his ABN), same ownership rule as the other accounts.
- **Tap to Pay on iPhone entitlement** (`com.apple.developer.proximity-reader.payment.acceptance`): request a
  development entitlement, test, then request the distribution entitlement. Apple's review time is outside our
  control, so this is the long pole.
- **Stripe**: in-person payments enabled on Ryan's account, Terminal Location, a restricted key for the
  Terminal endpoints.
- **TestFlight** for Ryan and the stylists; App Store release can follow, or stay on TestFlight and then
  unlisted distribution.
- **Stopgap that needs nothing built**: the Stripe Dashboard mobile app can take Tap to Pay payments today.
  Takings reach Stripe but are not attached to bookings until the matching work in section 4 exists, so treat
  it as a bridge, not the plan.

## 6. Phases

| Phase | Where                | Delivers                                                                                              |
| ----- | -------------------- | ----------------------------------------------------------------------------------------------------- |
| 0     | this repo + accounts | `/api/v1` foundation, bearer auth, OpenAPI; mobile repo scaffold; Apple and Stripe requests submitted |
| 1     | both                 | Sign in, today and week roster, booking detail, complete, no-show, cancel                             |
| 2     | both                 | Create and reschedule on the fly with live availability                                               |
| 3     | both                 | Terminal: connection token, checkout, Tap to Pay, receipts, reconciliation                            |
| 4     | both                 | Push notifications, clock in and out                                                                  |
| 5     | mobile               | TestFlight with Ryan, lock screen, offline read, polish                                               |

Phases 1 to 4 can overlap once phase 0 lands. Backend and app work can run as parallel lanes with a shared
OpenAPI contract, the way round 2 was built.

## 7. Decisions

Open (need an answer):

1. **Apple Developer account owner**: Ryan's entity, as with the others? The bundle id
   `world.hairmate.app` is a placeholder until it exists.
2. **Shared phone or personal phones?** Decides whether the PIN lock moves into v1.

Taken by default while building (change if wrong):

3. **Who may take payments**: every role already has the `checkout` permission on the web, so the app
   follows it. A stylist can only take payment on their own bookings. Refunds stay on the web.
4. **Push**: a new client booking and a client cancellation go to the stylist **and** the owners. Not
   notified yet: reschedules, waitlist claims, failed fee charges, a morning summary.
5. **Customer app**: not planned. The web booking flow and manage links stay the customer experience.
6. **No tipping**: Stripe lists it as unsupported on Tap to Pay readers.
