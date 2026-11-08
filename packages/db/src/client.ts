import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { drizzle as drizzlePg } from 'drizzle-orm/node-postgres';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import { drizzle as drizzlePglite } from 'drizzle-orm/pglite';
import pg from 'pg';
import * as schema from './schema';

export type Schema = typeof schema;

/** `execute()` results as both drivers return them (node-postgres and PGlite). */
export type HubQueryResult<Row> = { rows: Row[]; rowCount?: number | null; affectedRows?: number };
export interface HubQueryResultHKT extends PgQueryResultHKT {
  type: HubQueryResult<this['row']>;
}

/** A Drizzle database over either driver. Code outside this package never sees which. */
export type HubDb = PgDatabase<HubQueryResultHKT, Schema>;

export const migrationsFolder = fileURLToPath(new URL('../drizzle', import.meta.url));

export interface DbHandle {
  db: HubDb;
  kind: 'postgres' | 'pglite';
  close(): Promise<void>;
  /** Present for 'postgres': the pool, shared with pg-boss (docs/adr/0003). */
  pool?: pg.Pool;
  /** Present for 'postgres'. */
  url?: string;
  /** Present for 'pglite'. */
  pglite?: PGlite;
}

export interface PostgresOptions {
  /** Run `SET ROLE <role>` on every new connection, e.g. 'hub_auth' for Better Auth's pool. */
  role?: 'hub_auth' | 'hub_app';
  max?: number;
}

export function connectPostgres(url: string, opts: PostgresOptions = {}): DbHandle {
  const pool = new pg.Pool({
    connectionString: url,
    max: opts.max ?? 10,
    // Startup parameter, so the role is set before the first query on every connection.
    ...(opts.role ? { options: `-c role=${opts.role}` } : {}),
  });
  const db = drizzlePg(pool, { schema }) as unknown as HubDb;
  return { db, kind: 'postgres', pool, url, close: () => pool.end() };
}

/** An in-memory PGlite database (tests, CI). Pass `dataDir` to persist. */
export async function connectPglite(dataDir?: string): Promise<DbHandle> {
  const pglite = new PGlite(dataDir);
  await pglite.waitReady;
  const db = drizzlePglite(pglite, { schema }) as unknown as HubDb;
  return { db, kind: 'pglite', pglite, close: () => pglite.close() };
}
