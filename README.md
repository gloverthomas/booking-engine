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
