# Staff API (`/api/v1`)

For the iPhone app (see `docs/MOBILE.md`). It is a thin REST layer over the same commands and queries the
web admin uses, so permissions, audit and rules are identical. Customer-facing endpoints stay under
`/api/public`.

## Conventions

- **Auth**: `Authorization: Bearer <token>`. Get a token from `POST /auth/google`. Tokens are Better Auth
  sessions (30 days, refreshed on use), revoked by sign-out, by removing the person from the team, or by
  deactivating them.
- **Success**: `{ "data": ... }`. **Failure**: `{ "error": { "code", "message", "fields?" } }` with a real
  HTTP status. Branch on `code`; `message` is safe to show.
- **Times**: ISO 8601 with offset in requests; UTC ISO strings in responses. Dates without times
  (`fromDate`) are local to the business time zone, `YYYY-MM-DD`.
- **Scoping**: a stylist only ever sees and changes their own bookings and calendar; asking for someone
  else's booking is a `404`, exactly like a booking that does not exist.
- **Money**: integer cents.

| Status | `code`                                                          | Meaning                                                     |
| ------ | --------------------------------------------------------------- | ----------------------------------------------------------- |
| 400    | `invalid_json`, `rejected`                                      | Broken body, or the command refused with a sentence to show |
| 401    | `unauthenticated`, `sign_in_refused`                            | No or invalid token                                         |
| 403    | `forbidden`, `not_allowed`, `not_authorised`                    | Signed in, but the role cannot do this                      |
| 404    | `not_found`                                                     | Missing, malformed id, or not yours                         |
| 409    | `slot_taken`, `not_rostered`, `invalid_state`, `policy_changed` | The change conflicts with current state                     |
| 413    | `too_large`                                                     | Body over 256 KB                                            |
| 422    | `invalid_request`                                               | Field problems, listed in `error.fields`                    |
| 500    | `internal`                                                      | Logged server side, nothing leaked                          |

## Endpoints

| Method and path                                                        | Permission                | What it does                                                                                  |
| ---------------------------------------------------------------------- | ------------------------- | --------------------------------------------------------------------------------------------- |
| `POST /auth/google` `{ idToken, nonce? }`                              | none                      | Exchange a Google ID token (web or iOS client id) for `{ token, user, role, staffId }`        |
| `POST /auth/signout`                                                   | any                       | End the session                                                                               |
| `GET /me`                                                              | any                       | Role, permissions, staff id, business name and time zone                                      |
| `GET /resources`                                                       | calendar                  | Locations, visible stylists, active services, slot size                                       |
| `GET /availability?locationId&serviceIds=a,b&fromDate&toDate&staffId?` | `booking.create`          | Open start times, priced per stylist (max 15 days)                                            |
| `GET /calendar?from&to&locationId?&staffIds?`                          | calendar                  | Bookings and blocks in a range (max 62 days)                                                  |
| `GET /bookings?filter=upcoming\|past\|cancelled&q?&limit?`             | calendar                  | Booking list                                                                                  |
| `GET /bookings/:id`                                                    | calendar                  | Full detail with payments and what the viewer may do                                          |
| `POST /bookings`                                                       | `booking.create`          | Create and confirm a booking made by staff; `notifyClient` decides whether the client is told |
| `POST /bookings/:id/cancel` `{ depositMode, reason? }`                 | `booking.cancel`          | Cancel; returns the deposit action and any fee                                                |
| `POST /bookings/:id/reschedule` `{ newStart, notifyClient }`           | `booking.edit`            | Move it                                                                                       |
| `POST /bookings/:id/reassign` `{ newStaffId, notifyClient }`           | owner, manager, reception | Move it to another stylist                                                                    |
| `POST /bookings/:id/no-show`                                           | `booking.edit`            | Mark a no-show and apply the policy                                                           |
| `POST /bookings/:id/checkout` `{ method: cash\|eftpos\|other }`        | `checkout`                | Record a balance paid outside the app and close the booking                                   |
| `GET /clients?q=`                                                      | `clients.view`            | Search                                                                                        |
| `GET /clients/:id`                                                     | `clients.view`            | Profile and history                                                                           |

## Not built yet

Tap to Pay (Terminal connection token, card-present checkout, webhook), push device registration and
delivery, roster and timesheet endpoints, waitlist, and a generated OpenAPI document. See the phases in
`docs/MOBILE.md`.

## Sign-in and the iOS client id

Native Google Sign-In issues ID tokens for the **iOS** OAuth client, not the web one. Set
`GOOGLE_IOS_CLIENT_ID` on the web service; both client ids are then accepted, and the same allow-list
(`OWNER_EMAILS` plus active staff emails) applies. The signed `set-auth-token` form of the token comes from
a real Google sign-in, so confirm the full exchange against staging with a real account once the iOS client
exists.
