#!/usr/bin/env bun
import { connectPostgres, migrate, migrationStatus } from '@xjournal/db';

// `hub` CLI. M0: `hub migrate`. Later: note, sync, backup, restore, invite, import (plan.md §1).

const usage = `Usage: hub <command>

Commands:
  migrate            Apply pending database migrations (run before starting the hub)
  migrate --status   Show applied and expected migrations; exit 1 if any are pending

Environment:
  DATABASE_URL       Postgres connection string (the migration role must own the schema)`;

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (command !== 'migrate') {
    console.log(usage);
    return command ? 1 : 0;
  }
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL is not set.');
    return 1;
  }
  const handle = connectPostgres(url, { max: 1 });
  try {
    if (!rest.includes('--status')) {
      await migrate(handle);
    }
    const s = await migrationStatus(handle);
    console.log(
      `migrations: ${s.applied}/${s.expected} applied${s.upToDate ? ' (up to date)' : ''}`,
    );
    return s.upToDate ? 0 : 1;
  } finally {
    await handle.close();
  }
}

process.exit(await main(process.argv.slice(2)));
