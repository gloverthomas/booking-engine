# Booking engine

Self-owned replacement for Timely. See [PLAN.md](PLAN.md) for scope, stack and milestones.

## Layout

| Path         | What                                                                         |
| ------------ | ---------------------------------------------------------------------------- |
| `src/app`    | Next.js app (public booking, admin, API routes)                              |
| `src/db`     | Drizzle schema, DB client, migration runner                                  |
| `src/worker` | pg-boss background worker (separate process)                                 |
| `src/lib`    | Framework-agnostic helpers (env, logger, health)                             |
| `drizzle/`   | SQL migrations (generated, plus hand-written constraints)                    |
| `tests/`     | Vitest. Database tests run on in-process Postgres (PGlite), no Docker needed |

## Develop

```bash
pnpm install
cp .env.example .env.local   # point DATABASE_URL at any Postgres
pnpm db:migrate
pnpm dev                     # web on :3000
pnpm start:worker            # worker (separate terminal)
```

```bash
pnpm test           # unit + DB tests
pnpm test:coverage  # enforces 80%
pnpm typecheck && pnpm lint && pnpm format:check
```

## Schema changes

Edit `src/db/schema.ts`, run `pnpm db:generate`, review the SQL, commit it. Things Drizzle can't express (extensions, exclusion constraints) are added by hand to the migration with a comment.

## Deploy (Railway)

Two services from this repo plus Postgres.

| Service | Build          | Pre-deploy        | Start               |
| ------- | -------------- | ----------------- | ------------------- |
| web     | `pnpm build`   | `pnpm db:migrate` | `pnpm start:web`    |
| worker  | `pnpm install` | n/a               | `pnpm start:worker` |

Both need `DATABASE_URL` (reference the Postgres service variable). Health check path for web: `/api/health`.

## Error monitoring (Sentry)

Wired into the web app (server and browser) and the worker, and **off until a DSN is set**. Set
`SENTRY_DSN` (server and worker) and `NEXT_PUBLIC_SENTRY_DSN` (browser) on the host. Every event is
scrubbed in `src/lib/sentry.ts` before it leaves: the signed-in user, request bodies, cookies and headers
are dropped, and emails, phone numbers and manage-booking tokens are redacted from what remains. A
throwing worker job is reported and then retried by pg-boss as before. Set `SENTRY_AUTH_TOKEN`,
`SENTRY_ORG` and `SENTRY_PROJECT` at build time only if you want source maps uploaded.
