import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { DbHandle } from '@xjournal/db';
import { createTestDb } from '@xjournal/db/testing';
import { initLocal } from '@xjournal/services';
import { createApp } from '../src/app';

const token = 't'.repeat(32);
const config = {
  mode: 'local' as const,
  localToken: token,
  authSecret: 's'.repeat(32),
  baseURL: 'http://localhost',
};

let h: DbHandle;
let app: ReturnType<typeof createApp>;

function call(method: string, path: string, body?: unknown, auth: string | null = token) {
  return app.request(`/api/v1${path}`, {
    method,
    headers: {
      ...(auth ? { authorization: `Bearer ${auth}` } : {}),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}),
  });
}
// biome-ignore lint/suspicious/noExplicitAny: test helper over JSON responses
const json = async (r: Response): Promise<any> => r.json();

beforeAll(async () => {
  h = await createTestDb();
  app = createApp({ config, db: h });
});
afterAll(() => h.close());

describe('REST API, local mode', () => {
  test('needs the local token', async () => {
    const r = await call('GET', '/inbox', undefined, null);
    expect(r.status).toBe(401);
    expect(r.headers.get('content-type')).toContain('application/problem+json');
    expect((await call('GET', '/inbox', undefined, 'wrong'.repeat(8))).status).toBe(401);
  });

  test('says how to set up before `hub init`', async () => {
    const r = await call('GET', '/me');
    expect(r.status).toBe(409);
    expect(await json(r)).toMatchObject({ code: 'not_initialized', status: 409 });
  });

  test('projects, notes, routing, revisions and search end to end', async () => {
    await initLocal(h.db, { name: 'Sam', timeZone: 'UTC' });

    const created = await call('POST', '/projects', { slug: 'sdk', name: 'SDK' });
    expect(created.status).toBe(201);
    const project = await json(created);
    expect(project).toMatchObject({ slug: 'sdk', role: 'owner', timeZone: 'UTC' });

    const me = await json(await call('GET', '/me'));
    expect(me.user.name).toBe('Sam');
    expect(me.projects).toHaveLength(1);

    const n1 = await call('POST', '/notes', { text: 'Release notes drafted #sdk !win' });
    expect(n1.status).toBe(201);
    const first = await json(n1);
    expect(first).toMatchObject({ routed: true, note: { projectId: project.id, tags: ['win'] } });

    const n2 = await json(await call('POST', '/notes', { text: 'Unfiled release thought' }));
    expect(n2.routed).toBe(false);

    const inbox = await json(await call('GET', '/inbox'));
    expect(inbox.items.map((i: { id: string }) => i.id)).toEqual([n2.note.id]);

    const routed = await call('POST', `/records/${n2.note.id}/route`, { projectId: project.id });
    expect(routed.status).toBe(200);
    expect((await json(await call('GET', '/inbox'))).items).toEqual([]);

    const edited = await call('PATCH', `/notes/${first.note.id}`, {
      text: 'Release notes published',
    });
    expect((await json(edited)).revisionNo).toBe(2);
    const revs = await json(await call('GET', `/records/${first.note.id}/revisions`));
    expect(revs.items.map((r: { kind: string }) => r.kind)).toEqual(['created', 'content']);

    const hits = await json(await call('GET', '/search?q=release&limit=10'));
    expect(hits.items).toHaveLength(2);
    expect(hits.nextCursor).toBeNull();

    const record = await json(await call('GET', `/records/${n2.note.id}`));
    expect(record).toMatchObject({ id: n2.note.id, revisionNo: 2, routingStatus: 'confirmed' });
  });

  test('days: counts per date for the heatmap, and one day’s records', async () => {
    const project = (await json(await call('GET', '/projects'))).items[0];
    await call('POST', '/notes', { text: 'Older day #sdk @2026-01-05' });
    await call('POST', '/notes', { text: 'Same older day #sdk @2026-01-05 !meeting' });

    const days = await json(
      await call('GET', `/projects/${project.id}/days?from=2026-01-01&to=2026-02-01`),
    );
    expect(days.items).toEqual([
      {
        date: '2026-01-05',
        recordCount: 2,
        mineCount: 2,
        bundleHash: null,
        dirty: true, // no bundle built yet
        daily: null,
        coverage: {},
      },
    ]);

    const day = await json(await call('GET', `/projects/${project.id}/days/2026-01-05`));
    expect(day).toMatchObject({ date: '2026-01-05', workItems: [], daily: null });
    expect(day.unlinked.map((r: { title: string }) => r.title)).toEqual([
      'Older day',
      'Same older day',
    ]);

    expect(
      (await call('GET', `/projects/${project.id}/days?from=2026-02-01&to=2026-01-01`)).status,
    ).toBe(400);
    expect((await call('GET', `/projects/${project.id}/days/2026-02-30`)).status).toBe(400);
    expect((await call('GET', '/projects/01ARZ3NDEKTSV4RRFFQ69G5FAV/days/2026-01-05')).status).toBe(
      404,
    );
  });

  test('errors are problem+json with stable codes', async () => {
    const bad = await call('POST', '/notes', { text: '' });
    expect(bad.status).toBe(400);
    expect(await json(bad)).toMatchObject({ code: 'bad_request', errors: [{ path: 'text' }] });

    const notJson = await call('POST', '/notes', '{nope');
    expect(notJson.status).toBe(400);

    const missing = await call('GET', '/records/01ARZ3NDEKTSV4RRFFQ69G5FAV');
    expect(missing.status).toBe(404);
    expect(await json(missing)).toMatchObject({ code: 'not_found' });

    expect((await call('GET', '/nope')).status).toBe(404);
    expect((await call('POST', '/projects', { slug: 'sdk', name: 'dup' })).status).toBe(409);
  });
});

describe('REST API: settings, connectors, identities, bundles', () => {
  test('workspace and project settings', async () => {
    const ws = await json(await call('GET', '/workspace'));
    expect(ws).toMatchObject({ timeZone: 'UTC', weekStart: 1, isOwner: true });
    const patched = await call('PATCH', '/workspace', { name: 'Work', weekStart: 7 });
    expect(await json(patched)).toMatchObject({ name: 'Work', weekStart: 7 });
    expect((await call('PATCH', '/workspace', { timeZone: 'Mars/Base' })).status).toBe(400);

    const p = await json(await call('POST', '/projects', { slug: 'web', name: 'Web' }));
    const renamed = await json(
      await call('PATCH', `/projects/${p.id}`, { name: 'Website', timeZone: 'Asia/Seoul' }),
    );
    expect(renamed).toMatchObject({ name: 'Website', timeZone: 'Asia/Seoul' });
    const inherit = await json(await call('PATCH', `/projects/${p.id}`, { timeZone: null }));
    expect(inherit.timeZone).toBe('UTC');

    expect((await call('POST', `/projects/${p.id}/archive`)).status).toBe(204);
    const list = await json(await call('GET', '/projects'));
    expect(list.items.map((x: { slug: string }) => x.slug)).not.toContain('web');
  });

  test('connect GitHub, edit it, replace the token, disconnect', async () => {
    const kinds = await json(await call('GET', '/connector-kinds'));
    const gh = kinds.items.find((k: { kind: string }) => k.kind === 'github');
    expect(gh.streams.map((x: { key: string }) => x.key)).toEqual([
      'events',
      'search:opened',
      'search:merged',
    ]);
    expect(gh.configSchema.properties.host.type).toBe('string');

    const projects = await json(await call('GET', '/projects'));
    const sdk = projects.items.find((x: { slug: string }) => x.slug === 'sdk');
    const created = await call('POST', '/connectors', {
      kind: 'github',
      config: { host: 'github.com', login: 'octocat', excludeOwners: ['octocat'] },
      secret: 'ghp_not_a_real_token',
      projectIds: [sdk.id],
    });
    expect(created.status).toBe(201);
    const c = await json(created);
    expect(JSON.stringify(c)).not.toContain('ghp_not_a_real_token');
    expect(c).toMatchObject({ kind: 'github', hasSecret: true, projectIds: [sdk.id] });

    // The login was mapped as an identity.
    const ids = await json(await call('GET', '/identities?source=github:github.com'));
    expect(ids.items.map((i: { accountKey: string }) => i.accountKey)).toEqual(['octocat']);

    const edited = await json(
      await call('PATCH', `/connectors/${c.id}`, {
        displayName: 'GitHub (personal)',
        config: { host: 'github.com', login: 'octocat', includeOwners: ['acme'] },
        projectIds: [],
      }),
    );
    expect(edited).toMatchObject({ displayName: 'GitHub (personal)', projectIds: [] });
    expect(edited.config.includeOwners).toEqual(['acme']);
    const moveHost = await call('PATCH', `/connectors/${c.id}`, {
      config: { host: 'ghe.example.test', login: 'octocat' },
    });
    expect(moveHost.status).toBe(400);

    expect(
      (await call('PUT', `/connectors/${c.id}/secret`, { secret: 'ghp_rotated' })).status,
    ).toBe(204);
    expect((await call('DELETE', `/connectors/${c.id}`)).status).toBe(204);
    expect((await json(await call('GET', '/connectors'))).items).toEqual([]);
    expect((await call('POST', `/connectors/${c.id}/sync`)).status).toBe(404);
  });

  test('identities add, conflict, delete', async () => {
    const i = await call('POST', '/identities', {
      source: 'jira:jira.example.test',
      accountKey: 'sam',
    });
    expect(i.status).toBe(201);
    const id = (await json(i)).id;
    expect(
      (await call('POST', '/identities', { source: 'jira:jira.example.test', accountKey: 'sam' }))
        .status,
    ).toBe(409);
    expect((await call('DELETE', `/identities/${id}`)).status).toBe(204);
    expect((await call('DELETE', `/identities/${id}`)).status).toBe(404);
  });

  test('days report bundles; the morning run builds them', async () => {
    const projects = await json(await call('GET', '/projects'));
    const sdk = projects.items.find((x: { slug: string }) => x.slug === 'sdk');
    const before = await json(
      await call('GET', `/projects/${sdk.id}/days?from=2026-01-01&to=2027-01-01`),
    );
    expect(before.items.length).toBeGreaterThan(0);
    expect(before.items.every((d: { dirty: boolean }) => d.dirty)).toBe(true);

    const run = await json(await call('POST', '/runs/morning'));
    expect(run.bundles.built).toBeGreaterThan(0);
    const after = await json(
      await call('GET', `/projects/${sdk.id}/days?from=2026-01-01&to=2027-01-01`),
    );
    expect(
      after.items.every((d: { dirty: boolean; bundleHash: string }) => !d.dirty && d.bundleHash),
    ).toBe(true);

    const date = after.items[0].date;
    const day = await json(await call('GET', `/projects/${sdk.id}/days/${date}`));
    expect(day.bundle).toMatchObject({ dirty: false, hash: after.items[0].bundleHash });
    const rebuilt = await json(await call('POST', `/projects/${sdk.id}/days/${date}/rebuild`));
    expect(rebuilt).toMatchObject({ date, changed: false });
  });
});

describe('REST API: project rules', () => {
  test('create, preview, update with If-Match, deactivate', async () => {
    const projects = await json(await call('GET', '/projects'));
    const sdk = projects.items.find((x: { slug: string }) => x.slug === 'sdk');
    const created = await call('POST', '/rules', { projectId: sdk.id, match: { repo: 'acme/*' } });
    expect(created.status).toBe(201);
    const r = await json(created);

    const preview = await json(await call('POST', '/rules/preview', { match: { repo: 'acme/*' } }));
    expect(preview).toMatchObject({ total: 0, matches: [] });

    const put = (version: string | null, body: unknown) =>
      app.request(`/api/v1/rules/${r.id}`, {
        method: 'PUT',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          ...(version ? { 'if-match': version } : {}),
        },
        body: JSON.stringify(body),
      });
    expect((await json(await put('"1"', { priority: 3 }))).version).toBe(2);
    expect((await put('1', { priority: 4 })).status).toBe(412);

    const del = await app.request(`/api/v1/rules/${r.id}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${token}`, 'if-match': '2' },
    });
    expect(del.status).toBe(204);
    expect((await json(await call('GET', '/rules'))).items).toEqual([]);
    expect((await json(await call('POST', '/rules/apply'))).routed).toBe(0);
  });
});

describe('REST API: direct generation and export', () => {
  test('the key is write-only; generating without one is refused; export is Markdown', async () => {
    expect(await json(await call('GET', '/ai'))).toEqual({
      hasKey: false,
      model: 'claude-opus-5-5',
    });
    expect((await call('PUT', '/ai/key', { key: 'short' })).status).toBe(400);

    const projects = await json(await call('GET', '/projects'));
    const sdk = projects.items.find((x: { slug: string }) => x.slug === 'sdk');
    const r = await json(
      await call('POST', `/projects/${sdk.id}/reports/resolve`, {
        kind: 'daily',
        date: '2026-01-05',
      }),
    );
    const refused = await call('POST', `/reports/${r.reportId}/generate`, {});
    expect(refused.status).toBe(409);
    expect(await json(refused)).toMatchObject({ reason: 'direct_generation_disabled' });

    expect((await call('PUT', '/ai/key', { key: 'sk-ant-api-key-for-tests-only' })).status).toBe(
      204,
    );
    const ai = await json(await call('GET', '/ai'));
    expect(ai).toEqual({ hasKey: true, model: 'claude-opus-5-5' });
    expect(JSON.stringify(ai)).not.toContain('sk-ant');
    expect((await call('DELETE', '/ai/key')).status).toBe(204);

    // Export a hand-saved version.
    const inputs = await json(await call('GET', `/reports/${r.reportId}/inputs`));
    const rec = inputs.bundles[0].unlinked[0];
    const saved = await json(
      await call('POST', `/reports/${r.reportId}/versions`, {
        bodyMd: `- ${rec.title} [[r:${rec.revisionId}]]`,
        inputHash: inputs.inputHash,
      }),
    );
    const exp = await call('GET', `/report-versions/${saved.versionId}/export`);
    expect(exp.headers.get('content-type')).toContain('text/markdown');
    expect(exp.headers.get('content-disposition')).toContain('sdk-daily-2026-01-05-v1.md');
    const text = await exp.text();
    expect(text).toContain('kind: daily');
    expect(text).toContain('[^1]');
  });
});
