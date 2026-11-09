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
