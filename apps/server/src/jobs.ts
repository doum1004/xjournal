import type { DbHandle } from '@xjournal/db';
import { fromPglite, PgBoss } from 'pg-boss';

/**
 * The job queue (spec §16.2: pg-boss on the same Postgres). pg-boss owns the `pgboss` schema.
 *
 * - Postgres: pg-boss gets its own small pool from DATABASE_URL, so it can hold the
 *   LISTEN connection it uses for prompt pickup.
 * - PGlite (tests): through pg-boss's PGlite adapter, on the test database itself.
 *
 * See docs/adr/0003.
 */
export function createBoss(handle: DbHandle, connectionString?: string): PgBoss {
  if (handle.kind === 'pglite') {
    if (!handle.pglite) throw new Error('PGlite handle without a client');
    return new PgBoss({ db: fromPglite(handle.pglite), supervise: false, schedule: false });
  }
  if (!connectionString) throw new Error('createBoss: connectionString is required for Postgres');
  return new PgBoss({ connectionString, max: 4, application_name: 'xjournal-jobs' });
}
