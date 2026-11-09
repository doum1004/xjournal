import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { ConnectorRegistry } from '@xjournal/connectors';
import { newId } from '@xjournal/core';
import { type DbHandle, schema } from '@xjournal/db';
import { createTestDb } from '@xjournal/db/testing';
import { memorySecrets } from '@xjournal/secrets';
import { initLocal } from '@xjournal/services';
import { eq, sql } from 'drizzle-orm';
import { fromDrizzle, type PgBoss } from 'pg-boss';
import { createBoss, MORNING_QUEUE, startJobs } from '../src/jobs';

// Spike 3 (docs/adr/0003): pg-boss and Drizzle on Bun.
// Runs on PGlite by default; on Docker Postgres with HUB_TEST_DATABASE_URL set.

let h: DbHandle;
let boss: PgBoss;
const target = process.env.HUB_TEST_DATABASE_URL ? 'postgres' : 'pglite';

/** The connection string of the per-suite test database (Postgres only). */
async function currentUrl(): Promise<string | undefined> {
  const base = process.env.HUB_TEST_DATABASE_URL;
  if (!base) return undefined;
  const r = await h.db.execute<{ db: string }>(sql`select current_database() as db`);
  const u = new URL(base);
  u.pathname = `/${r.rows[0]?.db}`;
  return u.toString();
}

const waitFor = async (cond: () => boolean | Promise<boolean>, ms = 15_000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await cond()) return;
    await Bun.sleep(50);
  }
  throw new Error('timed out');
};

beforeAll(async () => {
  h = await createTestDb();
  boss = createBoss(h, await currentUrl());
  boss.on('error', (e) => console.error('pg-boss error', e));
  await boss.start();
});

afterAll(async () => {
  await boss?.stop({ graceful: false });
  await h?.close();
});

describe(`pg-boss on Bun (${target})`, () => {
  test('send → work round trip', async () => {
    await boss.createQueue('echo');
    const seen: unknown[] = [];
    await boss.work<{ n: number }>('echo', { pollingIntervalSeconds: 0.5 }, async ([job]) => {
      seen.push(job?.data.n);
    });
    await boss.send('echo', { n: 42 });
    await waitFor(() => seen.length === 1);
    expect(seen).toEqual([42]);
  });

  test("'exclusive' + singletonKey: a second send of the same morning job is a no-op", async () => {
    // One queued-or-active job per key, across every hub instance (spec §11.4 rule 3).
    await boss.createQueue('morning', { policy: 'exclusive' });
    const a = await boss.send('morning', { day: '2026-11-08' }, { singletonKey: '2026-11-08' });
    const b = await boss.send('morning', { day: '2026-11-08' }, { singletonKey: '2026-11-08' });
    expect(a).not.toBeNull();
    expect(b).toBeNull();
  });

  test('cron schedules are stored in the database', async () => {
    await boss.createQueue('cron-spike');
    await boss.schedule('cron-spike', '0 7 * * 1-5', null, { tz: 'America/New_York' });
    const schedules = await boss.getSchedules();
    expect(schedules.map((s) => s.name)).toContain('cron-spike');
  });

  test('transactional enqueue with Drizzle: a rolled-back transaction leaves no job', async () => {
    await boss.createQueue('tx-test');
    const wid = newId();
    const uid = newId();
    await h.db.insert(schema.users).values({ id: uid, displayName: 'tx' });

    const attempt = (commit: boolean) =>
      h.db
        .transaction(async (tx) => {
          await tx.insert(schema.workspaces).values({
            id: wid,
            domain: 'work',
            name: 'tx',
            ownerUserId: uid,
            timeZone: 'UTC',
          });
          await boss.send('tx-test', { wid }, { db: fromDrizzle(tx, sql) });
          if (!commit) throw new Error('rollback');
        })
        .catch(() => {});

    await attempt(false);
    expect(await boss.findJobs('tx-test')).toHaveLength(0);
    expect(
      await h.db.select().from(schema.workspaces).where(eq(schema.workspaces.id, wid)),
    ).toHaveLength(0);

    await attempt(true);
    expect(await boss.findJobs('tx-test')).toHaveLength(1);
  });

  test('startJobs: the morning run is scheduled, runs once per key, and builds bundles', async () => {
    await initLocal(h.db, { name: 'Jo', timeZone: 'UTC' });
    const logs: string[] = [];
    const jobs = await startJobs(boss, {
      db: h.db,
      connectors: { registry: new ConnectorRegistry([]), secrets: memorySecrets() },
      generate: { secrets: memorySecrets() },
      timeZone: 'UTC',
      log: (_level, msg) => logs.push(msg),
    });
    expect((await boss.getSchedules()).map((x) => x.name)).toContain(MORNING_QUEUE);
    const first = await jobs.enqueueMorningRun();
    const second = await jobs.enqueueMorningRun();
    expect(first).not.toBeNull();
    expect(second).toBeNull();
    await waitFor(() => logs.includes('morning run finished'));
  });
});
