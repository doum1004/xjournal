import { sql } from 'drizzle-orm';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { migrate as migratePg } from 'drizzle-orm/node-postgres/migrator';
import type { PgliteDatabase } from 'drizzle-orm/pglite';
import { migrate as migratePglite } from 'drizzle-orm/pglite/migrator';
import { type DbHandle, migrationsFolder, type Schema } from './client';

const config = {
  migrationsFolder,
  migrationsSchema: 'drizzle',
  migrationsTable: '__drizzle_migrations',
};

/**
 * Apply pending migrations. Run as a separate step (`hub migrate`), never on server start
 * (spec §11.4 rule 6). The connecting role must be able to create roles and own tables.
 */
export async function migrate(handle: DbHandle): Promise<void> {
  if (handle.kind === 'pglite') {
    await migratePglite(handle.db as unknown as PgliteDatabase<Schema>, config);
  } else {
    await migratePg(handle.db as unknown as NodePgDatabase<Schema>, config);
  }
}

export interface MigrationStatus {
  expected: number;
  applied: number;
  upToDate: boolean;
}

/** For /readyz: are all migrations in the build applied to this database? */
export async function migrationStatus(handle: DbHandle): Promise<MigrationStatus> {
  const expected = readMigrationFiles(config);
  const last = expected.at(-1);
  let applied = 0;
  let lastApplied: number | null = null;
  try {
    const rows = await handle.db.execute<{ n: number; last: string | null }>(
      sql`select count(*)::int as n, max(created_at)::text as last from drizzle.__drizzle_migrations`,
    );
    const row = rows.rows[0];
    applied = row?.n ?? 0;
    lastApplied = row?.last != null ? Number(row.last) : null;
  } catch {
    // No migrations table yet.
  }
  return {
    expected: expected.length,
    applied,
    upToDate: applied >= expected.length && (last == null || lastApplied === last.folderMillis),
  };
}
