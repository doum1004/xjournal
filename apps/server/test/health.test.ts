import { afterAll, beforeAll, expect, test } from 'bun:test';
import { connectPglite, type DbHandle, migrate } from '@xjournal/db';
import { createApp } from '../src/app';

let h: DbHandle;
let app: ReturnType<typeof createApp>;
const config = {
  mode: 'local' as const,
  localToken: 'x'.repeat(32),
  authSecret: 'y'.repeat(32),
  baseURL: 'http://localhost',
};

beforeAll(async () => {
  h = await connectPglite(); // not migrated yet
  app = createApp({ config, db: h });
});
afterAll(async () => {
  await h?.close();
});

test('/healthz answers without a database', async () => {
  const res = await app.request('/healthz');
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ status: 'ok' });
});

test('/readyz is 503 until migrations are applied, then 200', async () => {
  const before = await app.request('/readyz');
  expect(before.status).toBe(503);
  expect(((await before.json()) as { status: string }).status).toBe('migrations_pending');

  await migrate(h);
  const after = await app.request('/readyz');
  expect(after.status).toBe(200);
  expect(await after.json()).toMatchObject({ status: 'ready', upToDate: true });
});
