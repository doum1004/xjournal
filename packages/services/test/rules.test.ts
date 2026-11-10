import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { ConnectorRegistry } from '@xjournal/connectors';
import { fakeConnector, pagedStream } from '@xjournal/connectors/testing';
import { globMatches, ruleMatches } from '@xjournal/core';
import { type DbHandle, schema } from '@xjournal/db';
import { createTestDb } from '@xjournal/db/testing';
import { memorySecrets } from '@xjournal/secrets';
import { eq } from 'drizzle-orm';
import { type Seed, seed } from '../../db/test/fixtures';
import {
  addConnector,
  applyRules,
  type ConnectorDeps,
  type Ctx,
  createRule,
  deactivateRule,
  ingestRecords,
  listRules,
  previewRule,
  type ServiceError,
  syncConnector,
  updateRule,
} from '../src';

let h: DbHandle;
let s: Seed;
const ctx = (user: keyof Seed['u']): Ctx => ({
  db: h.db,
  actor: { userId: s.u[user], workspaceId: s.ws.W },
});
const status = (p: Promise<unknown>) =>
  p.then(
    () => 200,
    (e: unknown) => (e as ServiceError).status,
  );

beforeAll(async () => {
  h = await createTestDb();
  s = await seed(h);
});
afterAll(() => h.close());

describe('matching', () => {
  test('globs ignore case and escape regex characters', () => {
    expect(globMatches('acme/*', 'ACME/cli')).toBe(true);
    expect(globMatches('a.b', 'axb')).toBe(false);
    expect(globMatches('github:*', 'github:ghe.example.test')).toBe(true);
  });

  test('every condition must hold', () => {
    const r = {
      source: 'github:github.com',
      kind: 'pull_request',
      title: 'Fix the CLI',
      payload: { repo: 'acme/cli' },
    };
    expect(ruleMatches({ repo: 'acme/*' }, r)).toBe(true);
    expect(ruleMatches({ repo: 'acme/*', kinds: ['commit'] }, r)).toBe(false);
    expect(ruleMatches({ source: 'jira:*' }, r)).toBe(false);
    expect(ruleMatches({ titleContains: 'cli' }, r)).toBe(true);
    expect(ruleMatches({ project: 'PIX' }, r)).toBe(false); // no such payload field
    const msg = {
      source: 'slack:acme.slack.com',
      kind: 'message',
      title: 'Posted in #support-cli',
      payload: { channel: 'support-cli' },
    };
    expect(ruleMatches({ channel: 'support-*' }, msg)).toBe(true);
    expect(ruleMatches({ channel: '#support-*' }, msg)).toBe(true);
    expect(ruleMatches({ channel: 'dev' }, msg)).toBe(false);
  });
});

describe('rules', () => {
  test('managers and the workspace owner write; members read; others see nothing', async () => {
    const r = await createRule(ctx('dave'), { projectId: s.p.P, match: { repo: 'acme/cli' } });
    expect(r).toMatchObject({ projectId: s.p.P, version: 1, active: true, priority: 10 });
    expect(await status(createRule(ctx('bob'), { projectId: s.p.P, match: { repo: 'x' } }))).toBe(
      403,
    );
    expect(await status(createRule(ctx('dave'), { projectId: s.p.P, match: {} }))).toBe(400);
    expect(await status(createRule(ctx('dave'), { projectId: s.p.P, match: { bogus: 1 } }))).toBe(
      400,
    );
    expect((await listRules(ctx('carol'))).map((x) => x.id)).toEqual([r.id]); // viewer of P
    expect(await listRules(ctx('eve'))).toEqual([]); // not in P
    // The workspace owner may write rules in any project of the workspace.
    const owner = await createRule(ctx('alice'), { projectId: s.p.P, match: { space: 'ENG' } });
    expect(owner.priority).toBe(20);
    await deactivateRule(ctx('alice'), owner.id);
  });

  test('updates need the current version; a stale one is a 412', async () => {
    const [r] = await listRules(ctx('dave'));
    if (!r) throw new Error('expected a rule');
    const v2 = await updateRule(ctx('dave'), r.id, 1, { priority: 5 });
    expect(v2).toMatchObject({ version: 2, priority: 5 });
    expect(await status(updateRule(ctx('dave'), r.id, 1, { priority: 6 }))).toBe(412);
    expect(await status(updateRule(ctx('bob'), r.id, 2, { priority: 6 }))).toBe(403);
  });

  test('preview and apply route matching Inbox records', async () => {
    const rec = (id: string, repo: string) => ({
      externalId: id,
      kind: 'pull_request',
      eventTime: '2026-11-05T15:00:00Z',
      title: `PR ${id}`,
      url: `https://example.test/${id}`,
      actor: 'bob',
      payload: { repo },
    });
    await ingestRecords(ctx('bob'), {
      source: 'github:github.com',
      tier: 'webhook',
      records: [rec('a', 'acme/cli'), rec('b', 'acme/web'), rec('c', 'acme/cli')],
    });
    const preview = await previewRule(ctx('bob'), { match: { repo: 'acme/cli' } });
    expect(preview.total).toBe(2);
    expect(preview.matches.map((m) => m.title).sort()).toEqual(['PR a', 'PR c']);

    const applied = await applyRules(ctx('bob'));
    expect(applied).toEqual({ routed: 2, byProject: { [s.p.P]: 2 } });
    const rows = await h.db
      .select()
      .from(schema.records)
      .where(eq(schema.records.source, 'github:github.com'));
    const byExt = Object.fromEntries(rows.map((r) => [r.externalId, r]));
    expect(byExt.a).toMatchObject({ projectId: s.p.P, routedBy: 'rule', routingStatus: 'auto' });
    expect(byExt.b?.projectId).toBeNull();
    expect((await previewRule(ctx('bob'), { match: { repo: 'acme/cli' } })).total).toBe(0);
  });

  test('a sync files new records by rule, ahead of the account default', async () => {
    const fake = fakeConnector(
      {
        events: pagedStream(
          [
            {
              externalId: 'x1',
              kind: 'pull_request',
              eventTime: '2026-11-06T15:00:00Z',
              title: 'X1',
              url: 'https://f.test/1',
              actor: 'bob',
              payload: { repo: 'acme/cli' },
            },
            {
              externalId: 'x2',
              kind: 'pull_request',
              eventTime: '2026-11-06T15:00:00Z',
              title: 'X2',
              url: 'https://f.test/2',
              actor: 'bob',
              payload: { repo: 'acme/other' },
            },
          ],
          10,
        ),
      },
      { kind: 'ruled' },
    );
    const deps: ConnectorDeps = {
      registry: new ConnectorRegistry([fake]),
      secrets: memorySecrets(),
    };
    // bob contributes to P and Q; the account feeds Q by default.
    const c = await addConnector(ctx('bob'), deps, { kind: 'ruled', projectIds: [s.p.Q] });
    await syncConnector(ctx('bob'), deps, c.id);
    const rows = await h.db
      .select()
      .from(schema.records)
      .where(eq(schema.records.source, c.source));
    const byExt = Object.fromEntries(rows.map((r) => [r.externalId, r]));
    expect(byExt.x1).toMatchObject({ projectId: s.p.P, routedBy: 'rule' });
    expect(byExt.x2).toMatchObject({ projectId: s.p.Q, routedBy: 'connector' });
  });
});
