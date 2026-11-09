import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { DbHandle } from '@xjournal/db';
import { createTestDb } from '@xjournal/db/testing';
import { type Seed, seed } from '../../db/test/fixtures';
import {
  type Ctx,
  getRecord,
  ingestRecords,
  listInbox,
  listRevisions,
  ServiceError,
  search,
} from '../src';

let h: DbHandle;
let s: Seed;
const ctx = (user: keyof Seed['u']): Ctx => ({
  db: h.db,
  actor: { userId: s.u[user], workspaceId: s.ws.W },
});

const log = (date: string, title: string, extra: Record<string, unknown> = {}) => ({
  externalId: date,
  kind: 'imported_log',
  eventTime: `${date}T05:00:00Z`,
  applicableDate: date,
  title,
  summary: `${title}\n- details`,
  actor: 'worklog',
  payload: { text: `- ${title}` },
  ...extra,
});

beforeAll(async () => {
  h = await createTestDb();
  s = await seed(h);
});
afterAll(() => h.close());

describe('ingestRecords', () => {
  test('creates records in the project, filed and dated as given', async () => {
    const r = await ingestRecords(ctx('alice'), {
      source: 'confluence:worklog',
      tier: 'file_import',
      projectId: s.p.P,
      records: [log('2026-01-05', 'Planned the quarter'), log('2026-01-06', 'Paired on parser')],
    });
    expect(r).toEqual({ created: 2, updated: 0, unchanged: 0, rejected: [] });

    const hits = await search(ctx('alice'), { q: 'quarter' });
    expect(hits.items).toHaveLength(1);
    expect(hits.items[0]).toMatchObject({
      kind: 'imported_log',
      tier: 'file_import',
      source: 'confluence:worklog',
      externalId: '2026-01-05',
      projectId: s.p.P,
      routingStatus: 'confirmed',
      applicableDate: '2026-01-05',
      visibility: 'private',
    });
  });

  test('re-ingesting is idempotent; changed content adds a revision', async () => {
    const again = await ingestRecords(ctx('alice'), {
      source: 'confluence:worklog',
      tier: 'file_import',
      projectId: s.p.P,
      records: [
        log('2026-01-05', 'Planned the quarter'),
        log('2026-01-06', 'Paired on the parser'),
      ],
    });
    expect(again).toEqual({ created: 0, updated: 1, unchanged: 1, rejected: [] });

    const hit = (await search(ctx('alice'), { q: 'paired' })).items[0];
    expect(hit).toMatchObject({ title: 'Paired on the parser', revisionNo: 2 });
    const revs = await listRevisions(ctx('alice'), hit?.id as string);
    expect(revs.map((r) => [r.kind, r.title])).toEqual([
      ['created', 'Paired on parser'],
      ['content', 'Paired on the parser'],
    ]);
    expect(revs[1]?.payload).toMatchObject({ text: '- Paired on the parser', actor: 'worklog' });
  });

  test('the same external ID under another source is a different record', async () => {
    const r = await ingestRecords(ctx('alice'), {
      source: 'file:worklog',
      tier: 'file_import',
      projectId: s.p.P,
      records: [log('2026-01-05', 'Planned the quarter')],
    });
    expect(r.created).toBe(1);
  });

  test('without a project, records go to the Inbox and the date comes from the event time', async () => {
    const { applicableDate: _, ...noDate } = log('2026-02-01', 'Unfiled day');
    const r = await ingestRecords(ctx('alice'), {
      source: 'file:worklog',
      tier: 'file_import',
      records: [{ ...noDate, eventTime: '2026-02-02T03:00:00Z' }],
    });
    expect(r.created).toBe(1);
    const inbox = await listInbox(ctx('alice'), { limit: 200 });
    // 03:00 UTC is still Feb 1 in New York, the workspace time zone.
    expect(inbox.items.find((i) => i.title === 'Unfiled day')).toMatchObject({
      projectId: null,
      routingStatus: 'needs_review',
      applicableDate: '2026-02-01',
    });
  });

  test('bad items are rejected one by one; the rest still land', async () => {
    const r = await ingestRecords(ctx('alice'), {
      source: 'file:worklog',
      tier: 'file_import',
      projectId: s.p.P,
      records: [
        log('2026-03-01', 'Good one'),
        { ...log('2026-03-02', 'x'), title: '' },
        { externalId: '2026-03-03', kind: 'nope' },
        log('2026-03-01', 'Same key again'),
      ],
    });
    expect(r.created).toBe(1);
    expect(r.rejected.map((x) => [x.externalId, x.code])).toEqual([
      ['2026-03-02', 'bad_request'],
      ['2026-03-03', 'bad_request'],
      ['2026-03-01', 'conflict'],
    ]);
  });

  test('webhook and agent tiers need a url', async () => {
    const r = await ingestRecords(ctx('alice'), {
      source: 'webhook:abc',
      tier: 'webhook',
      records: [
        log('2026-04-01', 'No link'),
        log('2026-04-02', 'Linked', { url: 'https://x.test/1' }),
      ],
    });
    expect(r.created).toBe(1);
    expect(r.rejected).toEqual([
      { externalId: '2026-04-01', code: 'bad_request', message: 'url is required' },
    ]);
  });

  test('a viewer cannot ingest into the project; bad source keys are refused', async () => {
    const err = await ingestRecords(ctx('carol'), {
      source: 'file:worklog',
      tier: 'file_import',
      projectId: s.p.P,
      records: [log('2026-05-01', 'Nope')],
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ServiceError);
    expect((err as ServiceError).status).toBe(403);

    const bad = await ingestRecords(ctx('alice'), {
      source: 'Bad Source',
      tier: 'file_import',
      records: [],
    }).catch((e: unknown) => e);
    expect((bad as ServiceError).status).toBe(400);
  });

  test('imported records are private by default, so other members don’t see them', async () => {
    const hit = (await search(ctx('alice'), { q: 'quarter' })).items[0];
    const err = await getRecord(ctx('bob'), hit?.id as string).catch((e: unknown) => e);
    expect((err as ServiceError).status).toBe(404);
  });
});
