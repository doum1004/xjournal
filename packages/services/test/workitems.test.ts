import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { DbHandle } from '@xjournal/db';
import { createTestDb } from '@xjournal/db/testing';
import { type Seed, seed } from '../../db/test/fixtures';
import {
  type ConnectorDeps,
  type Ctx,
  describeIssue,
  getDay,
  getReportInputs,
  ingestRecords,
  type LinkInput,
  morningRun,
  planWorkItems,
  relinkWorkItems,
  resolveReport,
  routeRecord,
  saveReportVersion,
  search,
  textAnchors,
} from '../src';

// Work items (spec §3.5, docs/adr/0008): deterministic links, their storage, and where they
// show up (the day view, report inputs, citations).

describe('textAnchors', () => {
  test('Jira keys, Jira links and pull request links, in order', () => {
    expect(
      textAnchors(
        'PIX-12 fixes https://github.com/acme/sdk/pull/7 see https://jira.example.com/browse/OPS-3',
      ),
    ).toEqual(['PIX-12', 'acme/sdk#7', 'OPS-3']);
  });

  test('not Jira keys: encodings, hashes, lower case, parts of longer tokens', () => {
    expect(textAnchors('UTF-8, SHA-256, ISO-8601, pix-12, A-1, XPIX-12-3, foo/PIX-0')).toEqual([]);
  });

  test('a known Jira project wins over the stop list', () => {
    expect(textAnchors('ES-12', new Set(['ES']))).toEqual(['ES-12']);
    expect(textAnchors('ES-12')).toEqual([]);
  });
});

describe('describeIssue', () => {
  test('drops conventional prefixes and the key itself', () => {
    expect(describeIssue('PIX-1', 'feat(PIX-1): Add it')).toBe('PIX-1 Add it');
    expect(describeIssue('PIX-1', 'docs(PIX-1,PIX-2): Add it')).toBe('PIX-1 Add it');
    expect(describeIssue('PIX-1', 'fix #PIX-1: Add it')).toBe('PIX-1 Add it');
    expect(describeIssue('PIX-1', 'chore(dl): Add it (PIX-1)')).toBe('PIX-1 Add it');
    expect(describeIssue('PIX-1', 'PIX-1 Add it')).toBe('PIX-1 Add it');
    expect(describeIssue('PIX-1', 'Note: PIX-1 is done')).toBe('PIX-1 is done');
  });
});

describe('planWorkItems', () => {
  let n = 0;
  const rec = (o: Partial<LinkInput> & Pick<LinkInput, 'kind' | 'title'>): LinkInput => ({
    id: `r${++n}`,
    source: 'test',
    visibility: 'project',
    eventTime: new Date(Date.UTC(2026, 10, 2, 10, n)),
    payload: {},
    ...o,
  });
  const jira = (key: string, kind: string, title: string, summary?: string) =>
    rec({
      kind,
      title,
      summary: summary ?? null,
      url: `https://jira.example.com/browse/${key}?focusedCommentId=1`,
      payload: { issue: key, project: key.split('-')[0] },
    });
  const pr = (num: number, kind: string, title: string) =>
    rec({
      kind,
      title,
      url: `https://github.com/acme/sdk/pull/${num}`,
      payload: { repo: 'acme/sdk', number: num },
    });

  test('a PR naming an issue folds into it, with the Slack thread that links the PR', () => {
    const created = jira('PIX-1', 'issue_created', 'Created PIX-1 Crash on start');
    const opened = pr(5, 'pull_request', 'Opened PR #5: PIX-1 Fix the crash');
    const merged = pr(5, 'pull_request', 'Merged PR #5: PIX-1 Fix the crash');
    const review = pr(5, 'review', 'Reviewed PR #5 (approved): PIX-1 Fix the crash');
    const slack = rec({
      kind: 'message',
      title: 'Posted in #sdk',
      summary: 'Could someone look at https://github.com/acme/sdk/pull/5 ?',
    });
    const commit = rec({ kind: 'commit', title: 'PIX-1: guard the null config' });
    const other = rec({ kind: 'commit', title: 'Bump the version' });
    const items = planWorkItems([created, opened, merged, review, slack, commit, other]);
    expect(items).toEqual([
      {
        key: 'PIX-1',
        title: 'PIX-1 Crash on start',
        url: 'https://jira.example.com/browse/PIX-1',
        recordIds: [created.id, opened.id, merged.id, review.id, slack.id, commit.id],
      },
    ]);
  });

  test('a PR without an issue is its own item; one record alone is not an item', () => {
    const opened = pr(9, 'pull_request', 'Opened PR #9: Tidy the docs');
    const merged = pr(9, 'pull_request', 'Merged PR #9: Tidy the docs');
    const lone = pr(10, 'pull_request', 'Opened PR #10: Something else');
    expect(planWorkItems([opened, merged, lone])).toEqual([
      {
        key: 'acme/sdk#9',
        title: 'acme/sdk#9 Tidy the docs',
        url: 'https://github.com/acme/sdk/pull/9',
        recordIds: [opened.id, merged.id],
      },
    ]);
  });

  test('the issue title comes from a change summary, then from its own records', () => {
    const change = jira('PIX-2', 'issue_change', 'PIX-2: status: Open → Done', 'Fast startup');
    const comment = jira('PIX-2', 'issue_comment', 'Commented on PIX-2 Fast startup');
    expect(planWorkItems([comment, change])[0]?.title).toBe('PIX-2 Fast startup');
    const c2 = jira('PIX-3', 'issue_comment', 'Commented on PIX-3 Old name');
    const note = rec({ kind: 'note', title: 'Talked about PIX-3' });
    expect(planWorkItems([c2, note])[0]?.title).toBe('PIX-3 Old name');
  });

  test('without Jira records, keys in text still make an item', () => {
    const a = rec({ kind: 'commit', title: 'PIX-4 part one' });
    const b = rec({ kind: 'meeting', title: 'PIX-4 sync' });
    expect(planWorkItems([a, b])).toMatchObject([
      { key: 'PIX-4', title: 'PIX-4', url: null, recordIds: [a.id, b.id] },
    ]);
  });

  test('roundups, imported logs, context notes and Jira cross-references link nothing', () => {
    const own = [
      jira('PIX-5', 'issue_created', 'Created PIX-5 A'),
      jira('PIX-6', 'issue_created', 'Created PIX-6 B'),
      jira('PIX-7', 'issue_created', 'Created PIX-7 C'),
      jira('PIX-8', 'issue_created', 'Created PIX-8 D'),
    ];
    const roundup = rec({ kind: 'message', title: 'Standup', summary: 'PIX-5 PIX-6 PIX-7 PIX-8' });
    const log = rec({ kind: 'imported_log', title: 'Daily log', summary: 'PIX-5' });
    const ctx = rec({ kind: 'note', noteKind: 'context', title: 'We own PIX-5' });
    const dup = jira('PIX-9', 'issue_comment', 'Commented on PIX-9 E', 'duplicates PIX-5');
    expect(planWorkItems([...own, roundup, log, ctx, dup])).toEqual([]);
  });

  test('a PR naming two issues joins both', () => {
    const a = pr(11, 'pull_request', 'Opened PR #11: PIX-20 PIX-21 shared fix');
    const b = pr(11, 'pull_request', 'Merged PR #11: PIX-20 PIX-21 shared fix');
    expect(planWorkItems([a, b]).map((i) => [i.key, i.recordIds])).toEqual([
      ['PIX-20', [a.id, b.id]],
      ['PIX-21', [a.id, b.id]],
    ]);
  });

  test('the title prefers project-visible records', () => {
    const secret = rec({
      kind: 'note',
      title: 'PIX-30 secret plan',
      visibility: 'private',
      eventTime: new Date(0),
    });
    const shared = pr(12, 'pull_request', 'Opened PR #12: PIX-30 Public fix');
    expect(planWorkItems([secret, shared])[0]?.title).toBe('PIX-30 Public fix');
  });
});

// ------------------------------------------------------------------------------------------
// In the database
// ------------------------------------------------------------------------------------------

const NOW = new Date('2026-11-09T12:00:00Z'); // Monday 07:00 in New York

let h: DbHandle;
let s: Seed;
const ctx = (user: keyof Seed['u']): Ctx => ({
  db: h.db,
  actor: { userId: s.u[user], workspaceId: s.ws.W },
});

async function put(
  user: keyof Seed['u'],
  date: string,
  records: {
    externalId: string;
    kind: string;
    title: string;
    summary?: string;
    payload?: object;
  }[],
) {
  await ingestRecords(ctx(user), {
    source: 'test',
    tier: 'file_import',
    projectId: s.p.P,
    records: records.map((r, i) => ({
      eventTime: `${date}T1${i}:00:00Z`,
      applicableDate: date,
      actor: 'me',
      ...r,
    })),
  });
}

async function share(user: keyof Seed['u'], title: string) {
  const found = await search(ctx(user), { q: title, projectId: s.p.P });
  for (const r of found.items) await routeRecord(ctx(user), r.id, { visibility: 'project' });
}

beforeAll(async () => {
  h = await createTestDb();
  s = await seed(h);
  await put('bob', '2026-11-03', [
    { externalId: 'c1', kind: 'commit', title: 'PIX-1 add the flag' },
    { externalId: 'n1', kind: 'note', title: 'Lunch' },
  ]);
  await put('bob', '2026-11-04', [
    { externalId: 'c2', kind: 'commit', title: 'PIX-1 wire the flag' },
    { externalId: 'm1', kind: 'meeting', title: 'PIX-1 design review' },
  ]);
});
afterAll(() => h.close());

describe('relinking', () => {
  let itemId = '';

  test('the morning run links; the day view groups', async () => {
    const r = await morningRun(h.db, {} as ConnectorDeps, { now: NOW, skipSync: true });
    expect(r.workItems).toMatchObject({ items: 1, created: 1, linksAdded: 3, linksRemoved: 0 });

    const day = await getDay(ctx('bob'), s.p.P, '2026-11-04');
    expect(day.workItems).toHaveLength(1);
    expect(day.workItems[0]).toMatchObject({ key: 'PIX-1', title: 'PIX-1', url: null });
    expect(day.workItems[0]?.records.map((x) => x.title)).toEqual([
      'PIX-1 wire the flag',
      'PIX-1 design review',
    ]);
    expect(day.unlinked).toEqual([]);
    itemId = day.workItems[0]?.id as string;
    expect(day.workItems[0]?.records[0]?.workItemIds).toEqual([itemId]);

    const other = await getDay(ctx('bob'), s.p.P, '2026-11-03');
    expect(other.workItems[0]?.id).toBe(itemId);
    expect(other.unlinked.map((x) => x.title)).toEqual(['Lunch']);
  });

  test('relinking is idempotent and keeps the item ID', async () => {
    expect(await relinkWorkItems(h.db, { now: NOW })).toMatchObject({
      items: 1,
      created: 0,
      linksAdded: 0,
      linksRemoved: 0,
    });
    await put('bob', '2026-11-04', [
      { externalId: 'm1', kind: 'meeting', title: 'Design review' }, // retitled: no key now
    ]);
    expect(await relinkWorkItems(h.db, { now: NOW })).toMatchObject({
      items: 1,
      linksRemoved: 1,
    });
    const day = await getDay(ctx('bob'), s.p.P, '2026-11-04');
    expect(day.workItems[0]?.id).toBe(itemId);
    expect(day.unlinked.map((x) => x.title)).toEqual(['Design review']);
  });

  test('others see neither the item nor its links until a record is shared', async () => {
    const hidden = await getDay(ctx('alice'), s.p.P, '2026-11-04');
    expect(hidden.workItems).toEqual([]);
    await share('bob', 'wire');
    const shown = await getDay(ctx('alice'), s.p.P, '2026-11-04');
    expect(shown.workItems.map((w) => [w.id, w.records.map((x) => x.title)])).toEqual([
      [itemId, ['PIX-1 wire the flag']],
    ]);
    // The other day's record stays private, and so does its link.
    expect((await getDay(ctx('alice'), s.p.P, '2026-11-03')).workItems).toEqual([]);
  });
});

describe('reports', () => {
  test('daily inputs group by work item, and a version may cite it', async () => {
    const { reportId } = await resolveReport(ctx('bob'), {
      projectId: s.p.P,
      kind: 'daily',
      date: '2026-11-04',
    });
    const i = await getReportInputs(ctx('bob'), reportId, NOW);
    const b = i.bundles?.[0];
    expect(b?.workItems.map((w) => w.key)).toEqual(['PIX-1']);
    expect(b?.unlinked.map((r) => r.title)).toEqual(['Design review']);
    const w = b?.workItems[0];
    const rev = w?.records[0]?.revisionId;
    const other = b?.unlinked[0]?.revisionId;
    const v = await saveReportVersion(
      ctx('bob'),
      reportId,
      {
        bodyMd: `## SDK\n- Wired the flag [[w:${w?.id}]] [[r:${rev}]]\n\n## Meetings\n- Design review [[r:${other}]]`,
        inputHash: i.inputHash,
        generator: { path: 'agent', client: 'test' },
      },
      NOW,
    );
    expect(v.citations.find((c) => c.type === 'work_item')).toMatchObject({
      id: w?.id,
      title: 'PIX-1',
    });
  });

  test('weekly inputs list the week’s work items with their days', async () => {
    const { reportId } = await resolveReport(ctx('bob'), {
      projectId: s.p.P,
      kind: 'weekly',
      date: '2026-11-03',
    });
    const i = await getReportInputs(ctx('bob'), reportId, NOW);
    expect(i.workItems).toEqual([
      {
        id: expect.any(String),
        key: 'PIX-1',
        title: 'PIX-1',
        url: null,
        days: ['2026-11-03', '2026-11-04'],
        kinds: { commit: 2 },
      },
    ]);
  });

  test('an unknown work item is rejected', async () => {
    const { reportId } = await resolveReport(ctx('bob'), {
      projectId: s.p.P,
      kind: 'daily',
      date: '2026-11-03',
    });
    const i = await getReportInputs(ctx('bob'), reportId, NOW);
    const rev = i.bundles?.[0]?.unlinked[0]?.revisionId;
    const e = await saveReportVersion(
      ctx('bob'),
      reportId,
      {
        bodyMd: `## Notes\n- Lunch [[w:01NOPE]] [[r:${rev}]]`,
        inputHash: i.inputHash,
        generator: { path: 'agent', client: 'test' },
      },
      NOW,
    ).catch((x: unknown) => x as { status: number; details?: unknown });
    expect((e as { status: number }).status).toBe(422);
  });
});
