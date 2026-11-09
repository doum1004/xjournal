import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { ConnectorAuthError, ConnectorRegistry } from '@xjournal/connectors';
import { fakeConnector, pagedStream } from '@xjournal/connectors/testing';
import type { RecordInput } from '@xjournal/core';
import { type DbHandle, schema } from '@xjournal/db';
import { createTestDb } from '@xjournal/db/testing';
import { memorySecrets } from '@xjournal/secrets';
import { and, eq } from 'drizzle-orm';
import { type Seed, seed } from '../../db/test/fixtures';
import {
  addConnector,
  addIdentity,
  type ConnectorDeps,
  type Ctx,
  listConnectors,
  listIdentities,
  removeConnector,
  removeIdentity,
  ServiceError,
  syncConnector,
} from '../src';

const NOW = new Date('2026-11-08T12:00:00Z');
const TOKEN = 'tok_s3cret_value';

let h: DbHandle;
let s: Seed;
const ctx = (user: keyof Seed['u']): Ctx => ({
  db: h.db,
  actor: { userId: s.u[user], workspaceId: s.ws.W },
});

async function fails(p: Promise<unknown>, status: number, match?: RegExp) {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(ServiceError);
  expect((err as ServiceError).status).toBe(status);
  if (match) expect((err as ServiceError).message).toMatch(match);
  return err as ServiceError;
}

const item = (n: number, actor = 'octocat', extra: Partial<RecordInput> = {}): RecordInput => ({
  externalId: `item-${n}`,
  kind: 'pull_request',
  eventTime: `2026-11-0${(n % 7) + 1}T15:00:00Z`,
  title: `Item ${n}`,
  url: `https://fake.test/items/${n}`,
  actor,
  ...extra,
});

const dbRecords = (source: string) =>
  h.db.select().from(schema.records).where(eq(schema.records.source, source));

beforeAll(async () => {
  h = await createTestDb();
  s = await seed(h);
});
afterAll(() => h.close());

describe('connector accounts', () => {
  const fake = fakeConnector({ events: pagedStream([], 10) }, { kind: 'acct' });
  const secrets = memorySecrets();
  const deps: ConnectorDeps = { registry: new ConnectorRegistry([fake]), secrets };

  test('the credential goes to the secret store, never the database', async () => {
    const c = await addConnector(ctx('alice'), deps, {
      kind: 'acct',
      config: { host: 'one.test' },
      secret: TOKEN,
      projectIds: [s.p.P],
    });
    expect(c).toMatchObject({
      kind: 'acct',
      source: 'acct:one.test',
      authType: 'pat',
      hasSecret: true,
      status: 'ok',
      projectIds: [s.p.P],
    });
    expect(Object.values(secrets.entries())).toEqual([TOKEN]);
    const [row] = await h.db
      .select()
      .from(schema.connectorAccounts)
      .where(eq(schema.connectorAccounts.id, c.id));
    expect(JSON.stringify(row)).not.toContain(TOKEN);
    expect(row?.secretRef).toBe(`connector/${c.id}`);
  });

  test('bad input is a 400 and leaves no credential behind', async () => {
    const before = Object.keys(secrets.entries()).length;
    await fails(addConnector(ctx('alice'), deps, { kind: 'nope' }), 400, /Unknown connector/);
    await fails(
      addConnector(ctx('alice'), deps, { kind: 'acct', config: { host: 7 } }),
      400,
      /Invalid acct config/,
    );
    await fails(
      addConnector(ctx('alice'), deps, { kind: 'acct', secret: TOKEN, projectIds: ['missing'] }),
      404,
    );
    // A viewer of P can't attach a connector to it.
    await fails(
      addConnector(ctx('carol'), deps, { kind: 'acct', secret: TOKEN, projectIds: [s.p.P] }),
      403,
    );
    expect(Object.keys(secrets.entries()).length).toBe(before);
  });

  test('accounts are private to their owner', async () => {
    expect((await listConnectors(ctx('alice'))).length).toBe(1);
    expect(await listConnectors(ctx('dave'))).toEqual([]);
  });

  test('disconnecting deletes the credential and hides the account', async () => {
    const [c] = await listConnectors(ctx('alice'));
    if (!c) throw new Error('expected an account');
    await fails(removeConnector(ctx('dave'), deps, c.id), 404);
    await removeConnector(ctx('alice'), deps, c.id, NOW);
    expect(secrets.entries()).toEqual({});
    expect(await listConnectors(ctx('alice'))).toEqual([]);
    const all = await listConnectors(ctx('alice'), { includeDisconnected: true });
    expect(all[0]).toMatchObject({ status: 'disabled', hasSecret: false });
    await fails(syncConnector(ctx('alice'), deps, c.id), 404);
  });
});

describe('identities', () => {
  test('add, list, conflict and remove', async () => {
    const i = await addIdentity(ctx('bob'), {
      source: 'github:github.com',
      accountKey: 'bobby',
      aliases: ['Bob B', 'bob@example.test'],
    });
    await fails(addIdentity(ctx('bob'), { source: 'github:github.com', accountKey: 'bobby' }), 409);
    await fails(addIdentity(ctx('bob'), { source: 'Not A Source', accountKey: 'x' }), 400);
    expect(await listIdentities(ctx('bob'), 'github:github.com')).toEqual([i]);
    expect(await listIdentities(ctx('alice'))).toEqual([]);
    await fails(removeIdentity(ctx('alice'), i.id), 404);
    await removeIdentity(ctx('bob'), i.id);
    expect(await listIdentities(ctx('bob'))).toEqual([]);
  });
});

describe('syncConnector', () => {
  test('pages through a stream, files into the one project, and resumes from the cursor', async () => {
    const items = [1, 2, 3, 4, 5].map((n) => item(n, n === 5 ? 'someone-else' : 'octocat'));
    const fake = fakeConnector({ events: pagedStream(items, 2) }, { kind: 'pages' });
    const deps: ConnectorDeps = {
      registry: new ConnectorRegistry([fake]),
      secrets: memorySecrets(),
    };
    const c = await addConnector(ctx('alice'), deps, {
      kind: 'pages',
      secret: TOKEN,
      projectIds: [s.p.P],
    });
    await addIdentity(ctx('alice'), {
      source: c.source,
      accountKey: 'OctoCat', // matched case-insensitively
    });

    const first = await syncConnector(ctx('alice'), deps, c.id, { now: NOW, maxPages: 2 });
    expect(first.status).toBe('ok');
    expect(first.warnings).toEqual([]);
    expect(first.streams[0]).toMatchObject({ stream: 'events', created: 4, pages: 2, more: true });
    expect(fake.calls.map((x) => x.cursor)).toEqual([null, 2]);
    expect(fake.calls[0]?.secret).toBe(TOKEN);

    const second = await syncConnector(ctx('alice'), deps, c.id, { now: NOW });
    expect(second.streams[0]).toMatchObject({ created: 1, pages: 1, more: false });
    expect(fake.calls.at(-1)?.cursor).toBe(4);

    const rows = await dbRecords(c.source);
    expect(rows.length).toBe(5);
    for (const r of rows) {
      expect(r).toMatchObject({
        projectId: s.p.P,
        routingStatus: 'auto',
        routedBy: 'connector',
        tier: 'builtin',
        connectorAccountId: c.id,
        ownerUserId: s.u.alice,
      });
      expect(r.isMine).toBe(r.externalId !== 'item-5');
      expect(r.actorIdentityId != null).toBe(r.isMine);
    }

    const [view] = (await listConnectors(ctx('alice'))).filter((x) => x.id === c.id);
    expect(view?.status).toBe('ok');
    expect(view?.streams[0]).toMatchObject({
      stream: 'events',
      lastSuccessAt: NOW.toISOString(),
      lastError: null,
    });
  });

  test('re-syncing is idempotent; changed content adds a revision', async () => {
    let title = 'Original';
    const fake = fakeConnector(
      { events: () => ({ records: [item(1, 'x', { title })], cursor: null, more: false }) },
      { kind: 'idem' },
    );
    const deps: ConnectorDeps = {
      registry: new ConnectorRegistry([fake]),
      secrets: memorySecrets(),
    };
    const c = await addConnector(ctx('alice'), deps, { kind: 'idem' });
    expect(c.authType).toBe('none');

    const a = await syncConnector(ctx('alice'), deps, c.id, { now: NOW });
    const b = await syncConnector(ctx('alice'), deps, c.id, { now: NOW });
    title = 'Edited';
    const d = await syncConnector(ctx('alice'), deps, c.id, { now: NOW });
    expect([a, b, d].map((r) => r.streams[0]?.created)).toEqual([1, 0, 0]);
    expect(b.streams[0]?.unchanged).toBe(1);
    expect(d.streams[0]?.updated).toBe(1);

    // No project attached: the Inbox. No identities: a warning, and nothing counts as mine.
    expect(a.warnings[0]).toMatch(/No identities mapped/);
    const [row] = await dbRecords(c.source);
    expect(row).toMatchObject({
      projectId: null,
      routingStatus: 'needs_review',
      title: 'Edited',
      isMine: false,
    });
  });

  test('a failing stream records a redacted error and the others still run', async () => {
    const fake = fakeConnector(
      {
        broken: ({ secret }) => {
          throw new Error(`GET /x?token=${secret} failed: 500`);
        },
        fine: pagedStream([item(1)], 5, { historyFloor: new Date('2026-08-10T00:00:00Z') }),
      },
      { kind: 'flaky' },
    );
    const deps: ConnectorDeps = {
      registry: new ConnectorRegistry([fake]),
      secrets: memorySecrets(),
    };
    const c = await addConnector(ctx('alice'), deps, { kind: 'flaky', secret: TOKEN });

    const r = await syncConnector(ctx('alice'), deps, c.id, { now: NOW });
    expect(r.status).toBe('error');
    const [broken, fine] = r.streams;
    expect(broken?.error).toBe('GET /x?token=[redacted] failed: 500');
    expect(fine).toMatchObject({
      error: null,
      created: 1,
      historyFloor: '2026-08-10T00:00:00.000Z',
    });

    const states = await h.db
      .select()
      .from(schema.syncStates)
      .where(eq(schema.syncStates.connectorAccountId, c.id));
    expect(JSON.stringify(states)).not.toContain(TOKEN);
    const brokenState = states.find((x) => x.stream === 'broken');
    expect(brokenState?.lastError).toContain('[redacted]');
    expect(brokenState?.lastSuccessAt).toBeNull();
    expect(states.find((x) => x.stream === 'fine')?.historyFloor?.toISOString()).toBe(
      '2026-08-10T00:00:00.000Z',
    );
    const [view] = (await listConnectors(ctx('alice'))).filter((x) => x.id === c.id);
    expect(view?.status).toBe('error');
  });

  test('a refused credential stops the remaining streams', async () => {
    const fake = fakeConnector(
      {
        a: () => {
          throw new ConnectorAuthError('401 Bad credentials');
        },
        b: pagedStream([item(1)], 5),
      },
      { kind: 'authfail' },
    );
    const deps: ConnectorDeps = {
      registry: new ConnectorRegistry([fake]),
      secrets: memorySecrets(),
    };
    const c = await addConnector(ctx('alice'), deps, { kind: 'authfail', secret: TOKEN });
    const r = await syncConnector(ctx('alice'), deps, c.id, { now: NOW });
    expect(r.streams.map((x) => x.error)).toEqual([
      '401 Bad credentials',
      'skipped: the credential was refused',
    ]);
    expect(fake.calls.map((x) => x.stream)).toEqual(['a']);
  });

  test('a credential missing from the store fails the run before any stream', async () => {
    const fake = fakeConnector({ events: pagedStream([], 1) }, { kind: 'lost' });
    const secrets = memorySecrets();
    const deps: ConnectorDeps = { registry: new ConnectorRegistry([fake]), secrets };
    const c = await addConnector(ctx('alice'), deps, { kind: 'lost', secret: TOKEN });
    await secrets.delete(`connector/${c.id}`);
    await fails(syncConnector(ctx('alice'), deps, c.id), 400, /missing from the secret store/);
    expect(fake.calls).toEqual([]);
    const [view] = (await listConnectors(ctx('alice'))).filter((x) => x.id === c.id);
    expect(view?.status).toBe('error');
  });

  test('the first sync starts from backfillFrom, else 30 days back in local time', async () => {
    const fake = fakeConnector({ events: pagedStream([], 1) }, { kind: 'backfill' });
    const deps: ConnectorDeps = {
      registry: new ConnectorRegistry([fake]),
      secrets: memorySecrets(),
    };
    const a = await addConnector(ctx('alice'), deps, { kind: 'backfill', config: { host: 'a' } });
    const b = await addConnector(ctx('alice'), deps, {
      kind: 'backfill',
      config: { host: 'b' },
      backfillFrom: '2023-01-01',
    });
    await syncConnector(ctx('alice'), deps, a.id, { now: NOW });
    await syncConnector(ctx('alice'), deps, b.id, { now: NOW });
    await syncConnector(ctx('alice'), deps, b.id, { now: NOW, backfillFrom: '2024-05-01' });
    expect(fake.calls.map((x) => x.backfillFrom)).toEqual([
      '2026-10-09',
      '2023-01-01',
      '2024-05-01',
    ]);
    // The hub-level key isn't passed into the connector's config.
    expect(b.config).toEqual({ host: 'b', backfillFrom: '2023-01-01' });
  });

  test("another user can't sync, or see the records of, someone else's account", async () => {
    const fake = fakeConnector({ events: pagedStream([item(9)], 5) }, { kind: 'mine' });
    const deps: ConnectorDeps = {
      registry: new ConnectorRegistry([fake]),
      secrets: memorySecrets(),
    };
    const c = await addConnector(ctx('alice'), deps, { kind: 'mine' });
    await fails(syncConnector(ctx('bob'), deps, c.id), 404);
    await syncConnector(ctx('alice'), deps, c.id, { now: NOW });
    const rows = await h.db
      .select()
      .from(schema.records)
      .where(and(eq(schema.records.source, c.source), eq(schema.records.ownerUserId, s.u.alice)));
    expect(rows.length).toBe(1);
  });
});

describe('GitHub through the sync runner', () => {
  test('connect, map the login, sync all streams, and re-sync without changes', async () => {
    const merged = {
      number: 5,
      title: 'Ship it',
      repository_url: 'https://api.github.com/repos/acme/sdk',
      created_at: '2026-11-03T10:00:00Z',
      closed_at: '2026-11-04T20:00:00Z',
      user: { login: 'octocat' },
      pull_request: { merged_at: '2026-11-04T20:00:00Z' },
    };
    const routes: Record<string, unknown> = {
      '/users/octocat/events': [
        {
          id: '200',
          type: 'PullRequestEvent',
          created_at: '2026-11-04T20:00:00Z',
          actor: { login: 'octocat' },
          repo: { name: 'acme/sdk' },
          payload: {
            action: 'closed',
            number: 5,
            pull_request: {
              number: 5,
              title: 'Ship it',
              merged: true,
              merged_at: '2026-11-04T20:00:00Z',
            },
          },
        },
      ],
      '/search/issues': { items: [merged] },
    };
    const fetchFake = (async (u: string | URL | Request) => {
      const url = new URL(u instanceof Request ? u.url : String(u));
      const page = url.searchParams.get('page');
      if (url.pathname === '/users/octocat/events' && page !== '1') return Response.json([]);
      return Response.json(routes[url.pathname] ?? {}, {
        status: routes[url.pathname] ? 200 : 404,
      });
    }) as typeof fetch;
    const { github } = await import('@xjournal/connectors');
    const deps: ConnectorDeps = {
      registry: new ConnectorRegistry([github]),
      secrets: memorySecrets(),
      fetch: fetchFake,
    };
    const c = await addConnector(ctx('eve'), deps, {
      kind: 'github',
      config: { host: 'github.com', login: 'octocat' },
      secret: TOKEN,
      projectIds: [s.p.Q],
    });
    expect(await listIdentities(ctx('eve'), 'github:github.com')).toMatchObject([
      { accountKey: 'octocat' },
    ]);

    const first = await syncConnector(ctx('eve'), deps, c.id, { now: NOW });
    expect(first.status).toBe('ok');
    expect(first.warnings).toEqual([]);
    // The fake search ignores dates, so it answers every window; only creations matter here.
    expect(first.streams.map((x) => [x.stream, x.created])).toEqual([
      ['events', 1],
      ['search:opened', 1],
      ['search:merged', 0], // the same merge as the event: deduped
    ]);
    const second = await syncConnector(ctx('eve'), deps, c.id, { now: NOW });
    expect(second.streams.reduce((n, x) => n + x.created + x.updated, 0)).toBe(0);

    const rows = await h.db
      .select()
      .from(schema.records)
      .where(
        and(
          eq(schema.records.source, 'github:github.com'),
          eq(schema.records.ownerUserId, s.u.eve),
        ),
      );
    expect(rows.map((r) => [r.externalId, r.applicableDate, r.isMine, r.projectId]).sort()).toEqual(
      [
        ['acme/sdk#5/merged', '2026-11-04', true, s.p.Q],
        ['acme/sdk#5/opened', '2026-11-03', true, s.p.Q],
      ],
    );
  });
});
