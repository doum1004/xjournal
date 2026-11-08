# ADR 0004: PGlite for tests, parity-checked against Postgres 17

**Status:** Accepted, 2026-11-08 (M0 spike 4)
**Versions:** `@electric-sql/pglite` **0.4.6** (PostgreSQL 17.5), Docker `postgres:17` (17.11 at the time of writing)

## Context

Spec §16.2: tests and CI use PGlite (Postgres in WebAssembly); rule 1 pins **one major version** across local, tests and the managed target; rule 5 requires RLS policies to be tested from day one.

## Finding

The current PGlite release line (0.5.x, e.g. 0.5.15) embeds **PostgreSQL 18.6**. The last line on Postgres 17 is 0.4.x; 0.4.6 reports 17.5.

## Decision

- Pin `@electric-sql/pglite` to **0.4.6** and `postgres:17` in `infra/compose.yaml`. Upgrade both to 18 together, in one change, when we move majors.
- `createTestDb()` (`packages/db/src/testing.ts`) gives each suite a fresh migrated database: in-memory PGlite by default, or, with `HUB_TEST_DATABASE_URL` set, a throwaway database on that server that is dropped afterwards.
- `bun test` runs on PGlite; `bun run test:pg` runs the **same suites** on Docker Postgres. CI runs both jobs.

## Evidence

On 2026-11-08 the full suite (59 tests in 5 files: RLS, auth and OAuth, MCP, jobs, health) passed on both PGlite 0.4.6 and Postgres 17.11, with no test-specific branches except the one below. Both migrations ran identically on both engines: the Drizzle-generated schema, and the hand-written RLS migration (DO blocks, `CREATE ROLE`, SECURITY DEFINER functions, `FORCE ROW LEVEL SECURITY`). PGlite supports roles, `SET LOCAL ROLE` and forced RLS as Postgres does. No throwaway databases were left behind.

## Consequences

- **One known gap:** PGlite has a single connection, as the superuser. Code that needs a *second* connection under a different role can't be reproduced there. Better Auth's `hub_auth` pool is therefore only proven on the Postgres run, which is why that CI job is required, not optional.
- Driver differences are confined to `packages/db`: node-postgres reports `rowCount`, PGlite `affectedRows`; both are in `HubQueryResult`.
- The `pg_trgm` and `pgvector` extensions (spec §16.2 rule 2) aren't used yet. When they are (M5), load PGlite's matching extensions and switch the compose image to one that ships pgvector for Postgres 17.
