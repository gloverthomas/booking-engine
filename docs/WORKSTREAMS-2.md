# Round 2: more than one stylist, and the waitlist

Read `PLAN.md` (sections 6, 9, 13a), `docs/WORKSTREAMS.md` (round 1: the rules and how modules talk still
apply) and then this file. The business model is decided: **additional stylists are employees of the owner**.
All takings go through the owner's Stripe, Xero and ABN. Nobody gets their own payouts.

## First, in your worktree

Your worktree may start from an old commit. Before anything else:

```bash
git merge --ff-only feat/v1-integration   # nothing else; if it refuses, stop and report
pnpm install
ls docs/WORKSTREAMS-2.md                  # must exist
```

## Rules (round 1 rules, plus)

1. **Stay in your lane** (file lists below). If you need a change elsewhere, don't make it: put it under
   "Needs from integrator" in your final report.
2. **Never edit** `src/db/schema.ts`, `drizzle/`, `src/server/contracts.ts`, `src/server/events.ts`,
   `src/server/settings.ts`, `src/server/auth/permissions.ts`, `tests/helpers/**`, config files or another
   lane's files. The schema for everything in this round already exists (migration `0003`). If you think it
   is missing something, report it.
3. **Replacing a stub:** keep every exported signature (optional trailing params are fine) and delete your
   stub's line from the coverage `exclude` list in `vitest.config.mts`, nothing else in that file.
4. Test first, 80%+ coverage on your files, no `console.log`, no `any`, zod at boundaries, money in integer
   cents, times as UTC `Date`s with business-local logic via Luxon (read the zone from the business row).
5. Quality gates before you finish: `pnpm format && pnpm lint && pnpm typecheck && pnpm test:coverage &&
DATABASE_URL=postgres://ci:ci@localhost:5432/ci pnpm build`.
6. Commit on your own branch with conventional messages ending in
   `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`. **Do not push.**
7. Final report: what you built and where, what is tested, what is NOT done, "Needs from integrator", and
   decisions the brief did not cover.
8. Real browsers and databases: you cannot run a local Postgres in the browser here, so verify with typecheck,
   lint, unit tests (in-process Postgres via `tests/helpers/test-db.ts`) and `pnpm build`. Say what you could
   not check visually.

## Two late additions

- Event `booking.expired { bookingId }` exists. **W3's `expireHolds` must emit it** (inside the same transaction) for every hold it expires; W6's waitlist consumer offers the freed slot.
- Audit actors: `owner:<userId>` for the owner, `staff:<userId>` for any other signed-in team member (`Actor` in `src/server/audit.ts`).

## Shared pieces (already in place, read-only for you)

- **Roles and permissions:** `src/server/auth/permissions.ts` (`can(role, permission)`, `seesAllStaff(role)`).
  Roles: owner, manager, stylist, reception. Admin routes and actions call
  `requireAccess(permission)` from `src/server/auth/access.ts`, which returns
  `{ userId, email, staffId, role }`. **W1 replaces the stub**; until the merge it behaves as an owner. When a
  role cannot see everyone (`!seesAllStaff(role)`), scope every query to `session.staffId`.
- **Schema (migration 0003):** `staff` gained `role`, `userId`, `phone`, `colour`, `pinHash`;
  `service_level_price`; `roster_exception`; `time_entry`; `staff_target`; `booking.staffRequested`;
  `integration_account.staffId` (one Google calendar per stylist; Xero stays business-wide);
  `waitlist_entry`; `waitlist_offer`.
- **Settings added** (`BusinessSettings`): `waitlistEnabled`, `waitlistAutoOffer`, `waitlistOfferWindowMin`,
  `waitlistMaxOffersPerSlot`, `staffAlertsEnabled` (plus the existing `chooseStaff`).
- **Price resolution:** only through `priceFor(service, staffOverride, levelOverride)` in
  `src/server/pricing`. Precedence: service_staff override, then service_level_price for the stylist's level,
  then the service default.
- **Events added:** `waitlist.entry_joined`, `waitlist.offer_created`, `waitlist.offer_claimed`; consumer queue
  `consumer.waitlist`. **Stubs to implement or call:** `src/server/waitlist/index.ts` (W6),
  `src/server/booking/reassign.ts` (W3), `src/server/notifications/waitlist-notifications.ts` (W6),
  `src/components/public/waitlist/JoinWaitlistCta.tsx` (W6), `src/components/admin/clock/ClockWidget.tsx` (W4).

## Navigation (owned by W1)

W1 owns `src/components/admin/shell/**`. The nav becomes role-aware (show an item only when the role has its
permission) and gains these entries; items for pages that other lanes build simply 404 until the merge:

| Label        | Path                       | Permission            | Built by |
| ------------ | -------------------------- | --------------------- | -------- |
| Calendar     | `/calendar`                | `calendar.viewOwn`    | existing |
| Bookings     | `/bookings`                | `calendar.viewOwn`    | existing |
| Clients      | `/clients`                 | `clients.view`        | existing |
| Waitlist     | `/waitlist`                | `waitlist.manage`     | W6       |
| Roster       | `/roster` (replaces Hours) | `roster.viewOwn`      | W3       |
| Timesheets   | `/timesheets`              | `timesheets.viewOwn`  | W4       |
| Team         | `/team`                    | `reports.viewOwn`     | W4       |
| Reports      | `/reports`                 | `reports.viewOwn`     | W4       |
| Catalog      | `/catalog`                 | `catalog.edit`        | W5       |
| Staff        | `/staff`                   | `staff.manage`        | W1       |
| Integrations | `/integrations`            | `integrations.manage` | W1       |
| Settings     | `/settings`                | `settings.edit`       | W1       |

W1 mounts `<ClockWidget />` in the shell for anyone with `timesheets.clock`.

## Ownership

| ID  | Lane                                                    | Owns                                                                                                                                                                                                                                                                                                                                                                                 |
| --- | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| W1  | Staff and access                                        | `src/server/auth/**` (except `permissions.ts`), `src/server/staff/**`, `src/app/(admin)/staff/**`, `src/app/(admin)/settings/**`, `src/app/(admin)/integrations/**`, `src/app/(admin)/layout.tsx`, `src/app/(auth)/**`, `src/components/admin/shell/**`, `src/components/admin/staff/**`, `src/server/admin-foundation/{settings*,integrations*}`, `tests/auth/**`, `tests/staff/**` |
| W2  | Calendar, bookings, clients, checkout for many stylists | `src/app/(admin)/{calendar,bookings,clients,checkout}/**`, `src/components/admin/{calendar,clients}/**`, `src/server/admin/**`, `tests/admin/**`                                                                                                                                                                                                                                     |
| W3  | Roster and the domain core                              | `src/server/availability/**`, `src/server/booking/**`, `src/server/pricing/**`, `src/server/roster/**`, `src/app/(admin)/{roster,hours}/**`, `src/server/admin-foundation/hours*`, `tests/{availability,booking,roster}/**`                                                                                                                                                          |
| W4  | Timesheets, targets, performance, reports               | `src/server/timesheets/**`, `src/server/targets/**`, `src/server/reports/**`, `src/app/(admin)/{timesheets,team,reports}/**`, `src/components/admin/clock/**`, `tests/{timesheets,targets,reports}/**`                                                                                                                                                                               |
| W5  | Public booking with a choice of stylist, and pricing    | `src/app/(public)/{book,manage}/**`, `src/app/api/public/**` (except `waitlist`), `src/components/public/**` (except `waitlist/`), `src/lib/public-api-*.ts`, `src/app/(admin)/catalog/**`, `src/server/admin-foundation/catalog*`, `tests/public/**`                                                                                                                                |
| W6  | Waitlist                                                | `src/server/waitlist/**`, `src/server/notifications/waitlist-notifications.ts`, `src/emails/WaitlistOffer*`, `src/worker/handlers/waitlist.ts`, `src/app/(public)/waitlist/**`, `src/app/api/public/waitlist/**`, `src/components/public/waitlist/**`, `src/app/(admin)/waitlist/**`, `tests/waitlist/**`                                                                            |
| W7  | Per-stylist Google Calendar and staff alerts            | `src/server/integrations/google/**`, `src/server/integrations/common/**`, `src/worker/handlers/google.ts`, `src/app/api/integrations/google/**`, the non-waitlist parts of `src/server/notifications/**` (including `handle-event.ts`), `src/emails/**` (except `WaitlistOffer*`), `tests/{integrations,notifications}/**`                                                           |

Shared and owned by the integrator: `src/db/**`, `src/server/{contracts,events,settings,crypto,audit,clock,db-types,manage-token}.ts`,
`src/server/auth/permissions.ts`, `src/lib/**`, `src/worker/{index,context,jobs}.ts`, `src/worker/handlers/relay.ts`,
`tests/helpers/**`, `next.config.ts`, `docs/`, root config.
