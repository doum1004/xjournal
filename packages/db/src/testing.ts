import { connectPglite, connectPostgres, type DbHandle } from './client';
import { migrate } from './migrate';

/**
 * A fresh, migrated database for one test suite.
 *
 * - Default: in-memory PGlite (Postgres 17 in WebAssembly). No Docker needed; this is what CI runs.
 * - With HUB_TEST_DATABASE_URL set: a new throwaway database on that Postgres server, dropped
 *   on close. `bun run test:pg` uses this to run the same suites against Docker Postgres
 *   (the parity check, docs/adr/0004).
 */
export async function createTestDb(): Promise<DbHandle> {
  const url = process.env.HUB_TEST_DATABASE_URL;
  if (!url) {
    const handle = await connectPglite();
    await migrate(handle);
    return handle;
  }

  const name = `hub_test_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const admin = connectPostgres(url, { max: 1 });
  await admin.pool?.query(`create database ${name}`);
  await admin.close();

  const target = new URL(url);
  target.pathname = `/${name}`;
  const handle = connectPostgres(target.toString(), { max: 4 });
  await migrate(handle);

  return {
    ...handle,
    async close() {
      await handle.close();
      const cleanup = connectPostgres(url, { max: 1 });
      await cleanup.pool?.query(`drop database if exists ${name} with (force)`);
      await cleanup.close();
    },
  };
}

export const testTarget = (): 'postgres' | 'pglite' =>
  process.env.HUB_TEST_DATABASE_URL ? 'postgres' : 'pglite';
