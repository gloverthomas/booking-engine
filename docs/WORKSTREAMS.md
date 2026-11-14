# Workstreams: ownership and rules

Read `PLAN.md` first (especially sections 5 to 10). This file says who owns what so parallel work merges cleanly.

## Rules for every workstream

1. **Stay in your lane.** Only create or edit files listed under your workstream. If you need a change somewhere else, don't make it: describe it in your final report ("Needs from integrator").
2. **Never edit** `src/db/schema.ts`, `drizzle/`, `src/server/contracts.ts`, `src/server/events.ts` or another workstream's files. If you need a schema change, report it. (Exception: workstream D may add one auth migration.)
3. **Replacing a stub:** keep the exported signatures in the stub exactly, delete your line from the coverage `exclude` list in `vitest.config.mts`, and nothing else in that file.
4. **Test first** (Vitest, in-process Postgres via `tests/helpers/test-db.ts` and `tests/helpers/factories.ts`). Coverage for your files must be at least 80%. Put tests under `tests/<your area>/`.
5. **Pure logic takes dependencies as parameters** (db, clock, http clients, providers) so it is testable without network. Never call a real third-party API in tests. Never commit secrets. Read env through `getEnv()` and fail with a clear message if your keys are missing, but only when the feature is used, never at import time.
6. **Money is integer cents (AUD). Times are UTC `Date`s in code and `timestamptz` in the DB; local time is `Australia/Melbourne` via Luxon** (read the zone from the business row / settings, don't hardcode in logic).
7. **No `console.log`.** Use `createLogger` from `src/lib/logger.ts`. No `any`. Validate all external input with zod. Immutable updates.
8. **Quality gates before you finish:** `pnpm format && pnpm lint && pnpm typecheck && pnpm test:coverage && pnpm build` (build needs `DATABASE_URL=postgres://ci:ci@localhost:5432/ci`). All must pass.
9. **Commit on your own branch** (the worktree already is one) with conventional messages ending in the `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>` line. **Do not push.** Do not touch git config or other branches.
10. **Dependencies:** you may `pnpm add` what you need. Say so in your report so the integrator can regenerate the lockfile after merging.
11. Read `node_modules/next/dist/docs/` before writing Next.js code: this is Next 16 with `cacheComponents` enabled, and it differs from older versions (for example the `dynamic` route segment config is not allowed).
12. **Final report** (this is all the integrator sees): what you built and where, what is tested, what is NOT done or only stubbed, anything in "Needs from integrator", and any decisions you made that the plan did not cover.

## Ownership map

| ID  | Workstream                                        | Owns                                                                                                                                                                                                                                      |
| --- | ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A   | Domain core: availability + booking lifecycle     | `src/server/availability/**`, `src/server/booking/**`, `src/server/pricing/**`, `src/server/clients/**` (find-or-create client, phone/email normalisation, merge), `tests/availability/**`, `tests/booking/**`                            |
| B   | Public booking flow (UI + API)                    | `src/app/(public)/**` (the `/book` flow and `/manage/[token]`), `src/app/api/public/**`, `src/components/public/**`, `src/lib/turnstile.ts`, `tests/public/**`                                                                            |
| C   | Payments (Stripe)                                 | `src/server/payments/**`, `src/app/api/webhooks/stripe/**`, `src/worker/handlers/payments.ts`, `tests/payments/**`                                                                                                                        |
| D   | Admin foundation: auth, shell, catalog & settings | `src/server/auth/**`, `src/db/auth-schema.ts` + one migration, `src/app/(admin)/layout.tsx`, `src/app/(admin)/login/**`, `src/app/(admin)/settings/**`, `catalog/**`, `hours/**`, `src/components/admin/shell/**`, `src/components/ui/**` |
| E   | Admin operations: calendar, bookings, clients     | `src/app/(admin)/calendar/**`, `bookings/**`, `clients/**`, `checkout/**`, `src/components/admin/calendar/**`, `src/components/admin/clients/**`, `src/server/admin/**` (query/command functions for those screens)                       |
| F   | Notifications: email, SMS, reminders              | `src/server/notifications/**`, `src/worker/handlers/notifications.ts`, `src/emails/**`, `tests/notifications/**`                                                                                                                          |
| G   | Integrations: Google Calendar + Xero              | `src/server/integrations/google/**`, `src/server/integrations/xero/**`, `src/worker/handlers/google.ts`, `src/worker/handlers/xero.ts`, `src/app/api/integrations/**`, `tests/integrations/**`                                            |
| H   | Reports + MCP server                              | `src/server/reports/**`, `src/app/(admin)/reports/**`, `src/server/mcp/**`, `src/app/mcp/**` (or `src/app/api/mcp/**`), `tests/reports/**`, `tests/mcp/**`                                                                                |

Shared, owned by the integrator (read-only for you): `src/db/**` (except D's auth files), `src/server/{contracts,events,settings,crypto,clock,db-types}.ts`, `src/lib/**`, `src/worker/{index,context,jobs}.ts`, `src/worker/handlers/relay.ts`, `tests/helpers/**`, config files, `docs/`.

## How modules talk

- **Contracts:** `src/server/contracts.ts` defines the shared types. Stubs in `src/server/{availability,booking,payments}/index.ts` define function signatures so every workstream compiles in isolation. Call those functions; the real implementations arrive at merge.
- **Events:** state changes emit `DomainEvent`s (`src/server/events.ts`) in the same transaction. The worker relays each event to the consumer queues `consumer.notifications`, `consumer.google`, `consumer.xero`. Each consumer handler ignores event types it does not handle and must be idempotent.
- **Auth guard:** admin routes and server actions call `requireOwner()` from `src/server/auth/index.ts` (D owns it; until D lands, treat it as `() => Promise<{ userId: string }>` and import it, D's stub exists below).
- **Audit:** every staff or MCP mutation writes an `audit_log` row via `recordAudit(db, ...)` from `src/server/audit.ts` (integrator provides).
