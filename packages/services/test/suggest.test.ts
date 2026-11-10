import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { DbHandle } from '@xjournal/db';
import { createTestDb } from '@xjournal/db/testing';
import { memorySecrets } from '@xjournal/secrets';
import { type Seed, seed } from '../../db/test/fixtures';
import {
  type Ctx,
  getDay,
  getReportInputs,
  ingestRecords,
  morningRun,
  parseSuggestions,
  type ReportWriter,
  relinkWorkItems,
  resolveReport,
  type SuggestDeps,
  suggestPrompt,
  suggestWorkItemLinks,
} from '../src';

// AI-suggested work item links (spec §3.5, docs/adr/0009): what the model is asked, how its
// answer is read, and how guesses are stored, shown and superseded.

const item = (id: string, title: string) => ({ id, key: null, title, records: [`${title} PR`] });
const rec = (id: string, title: string) => ({
  id,
  revisionId: `${id}-rev`,
  source: 'slack',
  kind: 'message',
  title,
  eventTime: new Date('2026-11-04T10:00:00Z'),
});

describe('the prompt and the answer', () => {
  const items = [item('W1', 'PIX-1 Flag'), item('W2', 'PIX-2 Docs')];
  const records = [rec('R1', 'flag rollout'), rec('R2', 'lunch'), rec('R3', 'docs typo')];

  test('items and records are labelled w1…, r1…, never by ID', () => {
    const p = suggestPrompt(items, records);
    expect(p).toContain('w1: PIX-1 Flag\n  - PIX-1 Flag PR');
    expect(p).toContain('r2 (2026-11-04, slack message): lunch');
    expect(p).not.toContain('R1');
  });

  test('unknown labels and low confidences are dropped; a record keeps its best item', () => {
    const text = `Here you go:
{"links":[
  {"record":"r1","item":"w1","confidence":0.7},
  {"record":"r1","item":"w2","confidence":0.9},
  {"record":"r2","item":"w1","confidence":0.4},
  {"record":"r9","item":"w1","confidence":0.9},
  {"record":"r3","item":"w7","confidence":0.9}
]}`;
    expect(parseSuggestions(text, items, records)).toEqual([
      { workItemId: 'W2', recordId: 'R1', confidence: 0.9 },
    ]);
  });

  test('an answer that is not the JSON asked for is an error', () => {
    expect(() => parseSuggestions('No links.', items, records)).toThrow();
    expect(() => parseSuggestions('{"links":[{"record":"r1"}]}', items, records)).toThrow();
  });
});

// ------------------------------------------------------------------------------------------
// In the database
// ------------------------------------------------------------------------------------------

const NOW = new Date('2026-11-09T12:00:00Z');
const KEY = { 'anthropic/api-key': 'sk-ant-test-key-0123456789' };

let h: DbHandle;
let s: Seed;
const ctx = (user: keyof Seed['u']): Ctx => ({
  db: h.db,
  actor: { userId: s.u[user], workspaceId: s.ws.W },
});

async function put(
  date: string,
  records: { externalId: string; kind: string; title: string }[],
  hour = 1,
) {
  await ingestRecords(ctx('bob'), {
    source: 'test',
    tier: 'file_import',
    projectId: s.p.P,
    records: records.map((r, i) => ({
      eventTime: `${date}T${hour}${i}:00:00Z`,
      applicableDate: date,
      actor: 'me',
      ...r,
    })),
  });
}

/** A model that links every record whose line mentions `match` to w1, and says "lunch" weakly. */
function fakeModel(match: string) {
  const calls: string[] = [];
  const writer: SuggestDeps['writer'] = (): ReportWriter => ({
    async write(req) {
      const prompt = req.messages[0]?.content ?? '';
      calls.push(prompt);
      const links = prompt
        .split('\n')
        .map((l) => l.match(/^(r\d+) .*?: (.*)$/))
        .filter((m): m is RegExpMatchArray => !!m)
        .flatMap(([, label, title]) =>
          title?.includes(match)
            ? [{ record: label, item: 'w1', confidence: 0.8 }]
            : title?.includes('Lunch')
              ? [{ record: label, item: 'w1', confidence: 0.3 }]
              : [],
        );
      return { text: JSON.stringify({ links }), model: 'fake' };
    },
  });
  return { writer, calls };
}

beforeAll(async () => {
  h = await createTestDb();
  s = await seed(h);
  await put('2026-11-03', [
    { externalId: 'c1', kind: 'commit', title: 'PIX-1 add the flag' },
    { externalId: 'n1', kind: 'note', title: 'Lunch' },
    { externalId: 'l1', kind: 'imported_log', title: 'Daily log, flag rollout and more' },
  ]);
  await put('2026-11-04', [
    { externalId: 'c2', kind: 'commit', title: 'PIX-1 wire the flag' },
    { externalId: 'm1', kind: 'meeting', title: 'Flag rollout sync' },
  ]);
  await relinkWorkItems(h.db, { now: NOW });
});
afterAll(() => h.close());

describe('suggesting links', () => {
  let itemId = '';

  test('without a Claude API key nothing is asked', async () => {
    const { writer, calls } = fakeModel('rollout');
    const r = await suggestWorkItemLinks(h.db, { secrets: memorySecrets(), writer }, { now: NOW });
    expect(r).toEqual({ status: 'no_key', projects: 0, asked: 0, linked: 0, failed: 0 });
    expect(calls).toEqual([]);
  });

  test('a confident guess is stored and shown as suggested; a weak one is not', async () => {
    const { writer, calls } = fakeModel('rollout');
    const r = await suggestWorkItemLinks(
      h.db,
      { secrets: memorySecrets(KEY), writer },
      { now: NOW },
    );
    // The meeting and the note; imported logs are never asked about.
    expect(r).toEqual({ status: 'ok', projects: 1, asked: 2, linked: 1, failed: 0 });
    expect(calls[0]).toContain('w1: PIX-1');
    expect(calls[0]).not.toContain('Daily log');

    const day = await getDay(ctx('bob'), s.p.P, '2026-11-04');
    const w = day.workItems[0];
    itemId = w?.id as string;
    expect(w?.records.map((x) => [x.title, x.suggestedWorkItems?.[itemId]])).toEqual([
      ['PIX-1 wire the flag', undefined],
      ['Flag rollout sync', 0.8],
    ]);
    expect(day.unlinked).toEqual([]);
    const other = await getDay(ctx('bob'), s.p.P, '2026-11-03');
    expect(other.unlinked.map((x) => x.title)).toEqual([
      'Lunch',
      'Daily log, flag rollout and more',
    ]);
  });

  test('a record is asked about once per revision', async () => {
    const { writer, calls } = fakeModel('rollout');
    const deps = { secrets: memorySecrets(KEY), writer };
    expect(await suggestWorkItemLinks(h.db, deps, { now: NOW })).toMatchObject({ asked: 0 });
    expect(calls).toEqual([]);
    await put('2026-11-03', [
      { externalId: 'n1', kind: 'note', title: 'Lunch, then flag rollout' },
    ]);
    expect(await suggestWorkItemLinks(h.db, deps, { now: NOW })).toMatchObject({
      asked: 1,
      linked: 1,
    });
  });

  test('a failed call is asked again next time', async () => {
    await put('2026-11-05', [{ externalId: 's1', kind: 'message', title: 'rollout is live' }]);
    const broken: SuggestDeps['writer'] = () => ({
      async write() {
        return { text: 'Sorry, no JSON today.', model: 'fake' };
      },
    });
    expect(
      await suggestWorkItemLinks(
        h.db,
        { secrets: memorySecrets(KEY), writer: broken },
        { now: NOW },
      ),
    ).toMatchObject({ asked: 0, failed: 1 });
    const { writer } = fakeModel('rollout');
    expect(
      await suggestWorkItemLinks(h.db, { secrets: memorySecrets(KEY), writer }, { now: NOW }),
    ).toMatchObject({ asked: 1, linked: 1, failed: 0 });
  });

  test('reports see the guess: marked in daily inputs, counted in weekly ones', async () => {
    const daily = await resolveReport(ctx('bob'), {
      projectId: s.p.P,
      kind: 'daily',
      date: '2026-11-04',
    });
    const d = await getReportInputs(ctx('bob'), daily.reportId, NOW);
    const meeting = d.bundles?.[0]?.workItems[0]?.records.find((r) => r.kind === 'meeting');
    expect(meeting?.suggestedWorkItems).toEqual({ [itemId]: 0.8 });

    const weekly = await resolveReport(ctx('bob'), {
      projectId: s.p.P,
      kind: 'weekly',
      date: '2026-11-03',
    });
    const wk = await getReportInputs(ctx('bob'), weekly.reportId, NOW);
    expect(wk.workItems?.[0]).toMatchObject({ id: itemId, suggested: 3 });
  });

  test('a rule link supersedes the guess', async () => {
    await put('2026-11-04', [{ externalId: 'm1', kind: 'meeting', title: 'PIX-1 rollout sync' }]);
    const r = await relinkWorkItems(h.db, { now: NOW });
    expect(r).toMatchObject({ guessesDropped: 1, linksAdded: 1 });
    const day = await getDay(ctx('bob'), s.p.P, '2026-11-04');
    const meeting = day.workItems[0]?.records.find((x) => x.kind === 'meeting');
    expect(meeting?.workItemIds).toEqual([itemId]);
    expect(meeting?.suggestedWorkItems).toBeUndefined();
  });

  test('the morning run asks, unless told not to', async () => {
    await put('2026-11-06', [{ externalId: 's2', kind: 'message', title: 'rollout metrics' }]);
    const { writer, calls } = fakeModel('rollout');
    const deps = { registry: {} as never, secrets: memorySecrets(KEY) };
    const skipped = await morningRun(h.db, deps, {
      now: NOW,
      skipSync: true,
      skipSuggest: true,
      linkWriter: writer,
    });
    expect(skipped.suggestions).toBeUndefined();
    const r = await morningRun(h.db, deps, { now: NOW, skipSync: true, linkWriter: writer });
    expect(r.suggestions).toMatchObject({ status: 'ok', asked: 1, linked: 1 });
    expect(calls).toHaveLength(1);
  });
});
