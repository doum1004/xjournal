import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connectPglite, type DbHandle } from '@xjournal/db';
import { createApp } from '../src/app';

const config = {
  mode: 'local' as const,
  localToken: 'x'.repeat(32),
  authSecret: 'y'.repeat(32),
  baseURL: 'http://localhost',
};

let h: DbHandle;
let dist: string;
let outside: string;

beforeAll(async () => {
  h = await connectPglite();
  dist = mkdtempSync(join(tmpdir(), 'web-dist-'));
  mkdirSync(join(dist, 'assets'));
  writeFileSync(join(dist, 'index.html'), '<!doctype html><div id="root"></div>');
  writeFileSync(join(dist, 'assets', 'app-abc.js'), 'console.log(1)');
  outside = mkdtempSync(join(tmpdir(), 'web-secret-'));
  writeFileSync(join(outside, 'secret.txt'), 'nope');
});
afterAll(async () => {
  await h.close();
  rmSync(dist, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

describe('web UI serving', () => {
  test('files, client-side routes and cache headers', async () => {
    const app = createApp({ config, db: h, webDist: dist });

    const root = await app.request('/');
    expect(root.status).toBe(200);
    expect(root.headers.get('content-type')).toContain('text/html');
    expect(await root.text()).toContain('id="root"');

    const asset = await app.request('/assets/app-abc.js');
    expect(asset.headers.get('content-type')).toContain('text/javascript');
    expect(asset.headers.get('cache-control')).toContain('immutable');

    // Client-side routes get index.html.
    const route = await app.request('/day/2026-01-05');
    expect(await route.text()).toContain('id="root"');

    expect((await app.request('/assets/missing.js')).status).toBe(404);
  });

  test('never serves files outside the build', async () => {
    const app = createApp({ config, db: h, webDist: dist });
    const name = outside.split(/[\\/]/).at(-1);
    for (const path of [
      `/../${name}/secret.txt`,
      `/%2e%2e/${name}/secret.txt`,
      '/..%2f..%2fetc%2fpasswd',
    ]) {
      const res = await app.request(path);
      expect(await res.text()).not.toContain('nope');
    }
  });

  test('the API and health checks are not shadowed', async () => {
    const app = createApp({ config, db: h, webDist: dist });
    expect((await app.request('/healthz')).status).toBe(200);
    const api = await app.request('/api/v1/inbox');
    expect(api.status).toBe(401);
    expect(api.headers.get('content-type')).toContain('application/problem+json');
  });

  test('without a build, a hint instead of a blank page', async () => {
    const app = createApp({ config, db: h, webDist: join(dist, 'nope') });
    const res = await app.request('/');
    expect(res.status).toBe(404);
    expect(await res.text()).toContain('web:build');
  });
});
