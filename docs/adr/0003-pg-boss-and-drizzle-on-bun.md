# ADR 0003: pg-boss and Drizzle on Bun

**Status:** Accepted, 2026-11-08 (M0 spike 3)
**Versions:** Bun 1.4.4, `pg-boss` 12.38.1, `drizzle-orm` 0.45.4, `drizzle-kit` 0.31.11, `pg` 8.23.1

## Context

`plan.md` §3: if pg-boss or the Postgres drivers don't work on Bun, run the server on Node and keep Bun for tooling.

## Decision

Keep Bun for the server. No Node fallback.

- **Drizzle driver:** `node-postgres` (`pg`). pg-boss uses `pg` as well, so there's one driver. `HubDb` (`packages/db/src/client.ts`) is typed over both node-postgres and PGlite, so code outside `packages/db` can't tell them apart.
- **pg-boss connection:** its own small pool from `DATABASE_URL` (`apps/server/src/jobs.ts`), so it can hold the LISTEN connection it uses for prompt pickup. On PGlite it uses pg-boss's `fromPglite` adapter.
- **"Never double-run the morning job"** (spec §11.4 rule 3): queue policy `exclusive` plus a `singletonKey` per day. A second send while one is queued or active returns `null`.
- **Transactional enqueue:** `boss.send(…, { db: fromDrizzle(tx, sql) })` inside a Drizzle transaction. The job exists only if the transaction commits.

## Evidence

`apps/server/test/jobs.test.ts`, on PGlite and on Postgres 17, under Bun:
- send → work round trip
- `exclusive` + `singletonKey`: the second send is a no-op
- a cron schedule with a time zone is stored in the database
- transactional enqueue: a rolled-back transaction leaves neither the row nor the job; a committed one leaves both

Drizzle on Bun with node-postgres also runs every RLS, auth and migration test against Postgres 17 (ADR 0004).

## Consequences

- pg-boss creates and migrates its own `pgboss` schema on `start()`. That's not yet part of `hub migrate`. To keep spec §11.4 rule 6 (migrations as a separate step), run pg-boss's schema install from `hub migrate` and start the server's pg-boss with `migrate: false` once workers land (M2).
- `hub_app` has no grants on the `pgboss` schema. A transactional enqueue from inside `withActor` (under RLS) will need `USAGE` and `INSERT` grants there; decide in M2 when the first service enqueues work.
- In tests on PGlite, pg-boss runs with `supervise` and `schedule` off; scheduling behaviour is checked on the stored schedule, not by waiting for cron.
