import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { builtinConnectors } from '@xjournal/connectors';
import type { DbHandle } from '@xjournal/db';
import { createTestDb } from '@xjournal/db/testing';
import { memorySecrets } from '@xjournal/secrets';
import { type Seed, seed } from '../../db/test/fixtures';
import {
  addConnector,
  type ConnectorDeps,
  type Ctx,
  getReportInputs,
  ingestRecords,
  mirrorDaily,
  publishReport,
  resolveReport,
  ServiceError,
  saveReportVersion,
  updateConnector,
} from '../src';

const NOW = new Date('2026-11-09T12:00:00Z');
let h: DbHandle;
let s: Seed;
const ctx = (user: keyof Seed['u']): Ctx => ({
  db: h.db,
  actor: { userId: s.u[user], workspaceId: s.ws.W },
});

// A Confluence with one month page; PUTs replace its body.
const pages = new Map<string, { id: string; version: number; body: string }>([
  ['Work Logs - 2026', { id: '10', version: 1, body: '' }],
  [
    'November, 2026',
    { id: '11', version: 1, body: '<table><tbody><tr><th>Date</th></tr></tbody></table>' },
  ],
]);
const confluenceFetch = (async (u: string | URL | Request, init: RequestInit = {}) => {
  const url = new URL(u instanceof Request ? u.url : String(u));
  if ((init.method ?? 'GET') === 'GET') {
    const title = url.searchParams.get('title') ?? '';
    const p = pages.get(title);
    return Response.json({
      results: p
        ? [
            {
              id: p.id,
              title,
              version: { number: p.version },
              body: { storage: { value: p.body } },
              _links: { webui: `/x/${p.id}` },
            },
          ]
        : [],
    });
  }
  const body = JSON.parse(String(init.body));
  const p = [...pages.values()].find((x) => x.id === url.pathname.split('/').at(-1));
  if (!p) return new Response('no', { status: 404 });
  p.version = body.version.number;
  p.body = body.body.storage.value;
  return Response.json({ id: p.id });
}) as typeof fetch;

let deps: ConnectorDeps;
let accountId = '';
let versionId = '';

beforeAll(async () => {
  h = await createTestDb();
  s = await seed(h);
  deps = { registry: builtinConnectors(), secrets: memorySecrets(), fetch: confluenceFetch };
  const a = await addConnector(ctx('bob'), deps, {
    kind: 'confluence',
    config: {
      baseUrl: 'https://wiki.example.test',
      login: 'bob',
      worklog: { space: '~bob', rootPageId: '1' },
    },
    secret: 'tok',
  });
  accountId = a.id;
  await ingestRecords(ctx('bob'), {
    source: 'test',
    tier: 'file_import',
    projectId: s.p.P,
    records: [
      {
        externalId: 'x',
        kind: 'note',
        eventTime: '2026-11-04T15:00:00Z',
        applicableDate: '2026-11-04',
        title: 'Fixed [PIX-1]',
        actor: 'me',
      },
    ],
  });
  const r = await resolveReport(ctx('bob'), {
    projectId: s.p.P,
    kind: 'daily',
    date: '2026-11-04',
  });
  const i = await getReportInputs(ctx('bob'), r.reportId, NOW);
  const rec = i.bundles?.[0]?.unlinked[0];
  versionId = (
    await saveReportVersion(
      ctx('bob'),
      r.reportId,
      { bodyMd: `## SDK\n- Fixed [PIX-1] [[r:${rec?.revisionId}]]`, inputHash: i.inputHash },
      NOW,
    )
  ).versionId;
});
afterAll(() => h.close());

describe('publishing to the Confluence work log', () => {
  test('needs confirm; publishes the text without citations', async () => {
    await expect(publishReport(ctx('bob'), deps, { versionId })).rejects.toBeInstanceOf(
      ServiceError,
    );
    const r = await publishReport(ctx('bob'), deps, { versionId, confirm: true });
    expect(r).toMatchObject({
      status: 'published',
      date: '2026-11-04',
      pageTitle: 'November, 2026',
    });
    const body = pages.get('November, 2026')?.body ?? '';
    expect(body).toContain('datetime="2026-11-04"');
    expect(body).toContain('Fixed [PIX-1]');
    expect(body).not.toContain('[[r:');
  });

  test('republishing our own row works; a manual edit is refused, then forced', async () => {
    expect((await publishReport(ctx('bob'), deps, { versionId, confirm: true })).status).toBe(
      'published',
    );
    const p = pages.get('November, 2026');
    if (!p) throw new Error('page');
    p.body = p.body.replace('Fixed', 'Fixed (edited by hand)');
    const refused = await publishReport(ctx('bob'), deps, { versionId, confirm: true });
    expect(refused).toMatchObject({ status: 'refused' });
    expect(p.body).toContain('edited by hand');
    expect(
      (await publishReport(ctx('bob'), deps, { versionId, confirm: true, force: true })).status,
    ).toBe('published');
  });

  test('mirroring follows the account setting and never throws', async () => {
    const { getReport } = await import('../src');
    const v = await getReport(ctx('bob'), { versionId });
    expect(await mirrorDaily(ctx('bob'), deps, v)).toEqual({
      status: 'skipped',
      reason: 'mirroring is off',
    });
    await updateConnector(ctx('bob'), deps, accountId, {
      config: {
        baseUrl: 'https://wiki.example.test',
        login: 'bob',
        worklog: { space: '~bob', rootPageId: '1', mirrorDaily: true },
      },
    });
    expect((await mirrorDaily(ctx('bob'), deps, v)).status).toBe('published');
    // Someone else (no account) gets a skip, not an error.
    expect((await mirrorDaily(ctx('dave'), deps, { ...v })).status).toBe('skipped');
  });
});
