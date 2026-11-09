import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { ConnectorRegistry } from '@xjournal/connectors';
import { fakeConnector, pagedStream } from '@xjournal/connectors/testing';
import type { DbHandle } from '@xjournal/db';
import { createTestDb } from '@xjournal/db/testing';
import { memorySecrets } from '@xjournal/secrets';
import { sql } from 'drizzle-orm';
import { type Seed, seed } from '../../db/test/fixtures';
import {
  addConnector,
  type ConnectorDeps,
  type Ctx,
  coverageFor,
  getDay,
  ingestRecords,
  listDays,
  morningRun,
  rebuildBundles,
  rebuildDay,
  routeRecord,
  type ServiceError,
} from '../src';
import { coverageOf } from '../src/bundles';

// Workspace W is in America/New_York.
const NOW = new Date('2026-11-09T12:00:00Z'); // Monday, 07:00 in New York

let h: DbHandle;
let s: Seed;
const ctx = (user: keyof Seed['u']): Ctx => ({
  db: h.db,
  actor: { userId: s.u[user], workspaceId: s.ws.W },
});

const log = (date: string, title: string) => ({
  externalId: `${date}-${title}`,
  kind: 'note' as const,
  eventTime: `${date}T15:00:00Z`,
  applicableDate: date,
  title,
  actor: 'me',
});

async function put(user: keyof Seed['u'], date: string, title: string) {
  await ingestRecords(ctx(user), {
    source: 'file',
    tier: 'file_import',
    projectId: s.p.P,
    records: [log(date, title)],
  });
}

const days = async (user: keyof Seed['u'], from = '2026-10-01', to = '2026-11-10') =>
  Object.fromEntries((await listDays(ctx(user), s.p.P, { from, to })).map((d) => [d.date, d]));

beforeAll(async () => {
  h = await createTestDb();
  s = await seed(h);
});
afterAll(() => h.close());

describe('coverage', () => {
  const day = [new Date('2026-11-05T05:00:00Z'), new Date('2026-11-06T05:00:00Z')] as const;
  const stream = (o: Partial<Parameters<typeof coverageOf>[0][number]>) => ({
    connectorAccountId: 'c1',
    source: 'github:x',
    createdAt: new Date(0),
    stream: 'events',
    lastSuccessAt: null,
    lastAttemptAt: null,
    lastError: null,
    historyFloor: null,
    ...o,
  });

  test('complete, pending, error and truncated', () => {
    const after = new Date('2026-11-06T06:00:00Z');
    const before = new Date('2026-11-05T20:00:00Z');
    expect(coverageOf([stream({ lastSuccessAt: after })], ...day).status).toBe('complete');
    expect(
      coverageOf(
        [stream({ lastSuccessAt: after }), stream({ stream: 'b', lastSuccessAt: before })],
        ...day,
      ).status,
    ).toBe('pending');
    expect(coverageOf([stream({ lastSuccessAt: before, lastError: 'boom' })], ...day).status).toBe(
      'error',
    );
    expect(coverageOf([stream({ stream: null })], ...day).status).toBe('pending'); // never synced
    expect(
      coverageOf(
        [stream({ lastSuccessAt: after, historyFloor: new Date('2026-11-05T12:00:00Z') })],
        ...day,
      ),
    ).toEqual({
      source: 'github:x',
      status: 'truncated',
      truncatedBefore: '2026-11-05T12:00:00.000Z',
    });
  });

  test('day boundaries follow the time zone', () => {
    // 04:30 UTC on Nov 6 is still Nov 5 in New York: not past the end of that day yet.
    const c = coverageFor(
      [stream({ lastSuccessAt: new Date('2026-11-06T04:30:00Z') })],
      '2026-11-05',
      'America/New_York',
    );
    expect(c.c1?.status).toBe('pending');
  });
});

describe('bundles', () => {
  test('a day without a bundle is dirty; rebuilding builds it, and again changes nothing', async () => {
    await put('bob', '2026-11-05', 'one');
    await put('bob', '2026-11-05', 'two');
    expect(await days('bob')).toMatchObject({ '2026-11-05': { bundleHash: null, dirty: true } });

    const first = await rebuildBundles(h.db, { now: NOW });
    expect(first.changedDays).toEqual([{ projectId: s.p.P, date: '2026-11-05' }]);
    const d = (await days('bob'))['2026-11-05'];
    expect(d?.dirty).toBe(false);
    expect(d?.bundleHash).toMatch(/^[0-9a-f]{64}$/);

    const again = await rebuildBundles(h.db, { now: NOW });
    expect(again.changed).toBe(0);
    expect((await days('bob'))['2026-11-05']?.bundleHash).toBe(d?.bundleHash);
  });

  test('a new record marks its day dirty, and the rebuild changes the hash', async () => {
    const before = (await days('bob'))['2026-11-05']?.bundleHash;
    await put('bob', '2026-11-05', 'late note');
    expect((await days('bob'))['2026-11-05']?.dirty).toBe(true);
    await rebuildBundles(h.db, { now: NOW });
    const after = (await days('bob'))['2026-11-05'];
    expect(after?.dirty).toBe(false);
    expect(after?.bundleHash).not.toBe(before);
  });

  test('moving a record to another day dirties both days', async () => {
    await put('bob', '2026-11-04', 'mover');
    await rebuildBundles(h.db, { now: NOW });
    const day4 = await getDay(ctx('bob'), s.p.P, '2026-11-04');
    const id = day4.unlinked.find((r) => r.title === 'mover')?.id as string;
    await routeRecord(ctx('bob'), id, { date: '2026-11-05' });
    const [x] = (
      await listDays(ctx('bob'), s.p.P, { from: '2026-11-04', to: '2026-11-06' })
    ).filter((d) => d.date === '2026-11-05');
    expect(x?.dirty).toBe(true);
    const b4 = await getDay(ctx('bob'), s.p.P, '2026-11-04');
    expect(b4.bundle?.dirty).toBe(true);
    await rebuildBundles(h.db, { now: NOW });
    expect((await getDay(ctx('bob'), s.p.P, '2026-11-04')).bundle).toMatchObject({
      dirty: false,
      itemCount: 0,
    });
  });

  test('a bundle covers private records; members only count what they can see', async () => {
    await ingestRecords(ctx('bob'), {
      source: 'file',
      tier: 'file_import',
      projectId: s.p.P,
      records: [log('2026-11-03', 'visible')],
    });
    await ingestRecords(ctx('dave'), {
      source: 'file2',
      tier: 'file_import',
      projectId: s.p.P,
      records: [log('2026-11-03', 'daves private')],
    });
    await rebuildBundles(h.db, { now: NOW });
    const asDave = await getDay(ctx('dave'), s.p.P, '2026-11-03');
    const asBob = await getDay(ctx('bob'), s.p.P, '2026-11-03');
    expect(asDave.bundle?.hash).toBe(asBob.bundle?.hash as string);
    // Notes are private by default: each sees only their own, but the bundle holds both.
    expect(asDave.bundle?.itemCount).toBe(1);
    expect(asBob.bundle?.itemCount).toBe(1);
    const all = await h.db.execute<{ n: number }>(
      sql`select count(*)::int as n from bundle_items where bundle_id = ${asBob.bundle?.id}`,
    );
    expect(Number(all.rows[0]?.n)).toBe(2);
  });

  test('old days without a bundle are built too (imports, backfills); empty window days are skipped', async () => {
    await put('bob', '2025-01-15', 'from the archive');
    const r = await rebuildBundles(h.db, { now: NOW });
    expect(r.changedDays.map((d) => d.date)).toEqual(['2025-01-15']);
    const old = await listDays(ctx('bob'), s.p.P, { from: '2025-01-01', to: '2025-02-01' });
    expect(old[0]).toMatchObject({ date: '2025-01-15', dirty: false });
  });

  test('rebuilding one day needs contributor rights', async () => {
    const r = await rebuildDay(ctx('bob'), s.p.P, '2026-11-05');
    expect(r).toMatchObject({ date: '2026-11-05', changed: false });
    const err = await rebuildDay(ctx('carol'), s.p.P, '2026-11-05').catch((e: unknown) => e);
    expect((err as ServiceError).status).toBe(403);
    expect(
      ((await rebuildDay(ctx('bob'), s.p.P, 'nope').catch((e) => e)) as ServiceError).status,
    ).toBe(400);
  });
});

describe('morningRun', () => {
  test('syncs every connector as its owner, then builds bundles with coverage', async () => {
    const fake = fakeConnector(
      {
        events: pagedStream(
          [
            {
              externalId: 'pr-1',
              kind: 'pull_request',
              eventTime: '2026-11-06T18:00:00Z',
              title: 'PR 1',
              url: 'https://fake.test/1',
              actor: 'alice',
            },
          ],
          10,
        ),
      },
      { kind: 'morning' },
    );
    const deps: ConnectorDeps = {
      registry: new ConnectorRegistry([fake]),
      secrets: memorySecrets(),
    };
    const c = await addConnector(ctx('alice'), deps, { kind: 'morning', projectIds: [s.p.P] });

    const r = await morningRun(h.db, deps, { now: NOW });
    expect(r.syncs.map((x) => [x.source, x.status])).toEqual([[c.source, 'ok']]);
    expect(r.bundles.changedDays.map((d) => d.date)).toContain('2026-11-06');

    const day = await getDay(ctx('alice'), s.p.P, '2026-11-06');
    expect(day.coverage[c.id]).toEqual({ source: c.source, status: 'complete' });
    // Today isn't over, so it can't be complete.
    const today = await listDays(ctx('alice'), s.p.P, { from: '2026-11-09', to: '2026-11-10' });
    expect(today).toEqual([]); // no records today: no entry
  });
});
