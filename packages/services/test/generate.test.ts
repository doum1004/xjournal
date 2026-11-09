import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { DbHandle } from '@xjournal/db';
import { createTestDb } from '@xjournal/db/testing';
import { memorySecrets } from '@xjournal/secrets';
import { type Seed, seed } from '../../db/test/fixtures';
import {
  aiStatus,
  type Ctx,
  exportMarkdown,
  type GenerateDeps,
  generateReport,
  ingestRecords,
  refreshReports,
  resolveReport,
  ServiceError,
  setApiKey,
  type WriterMessage,
} from '../src';

const NOW = new Date('2026-11-09T12:00:00Z');
let h: DbHandle;
let s: Seed;
const ctx = (user: keyof Seed['u']): Ctx => ({
  db: h.db,
  actor: { userId: s.u[user], workspaceId: s.ws.W },
});

/** A writer that answers from a script; each reply sees the conversation so far. */
function scripted(replies: ((msgs: WriterMessage[]) => string)[]) {
  const seen: WriterMessage[][] = [];
  const factory = (key: string, model: string) => {
    expect(key).toBe('sk-ant-test-key-0123456789');
    return {
      async write(req: { system: string; messages: WriterMessage[] }) {
        seen.push(req.messages);
        const next = replies.shift();
        if (!next) throw new Error('no more scripted replies');
        return { text: next(req.messages), model };
      },
    };
  };
  return { factory, seen };
}

/** The [[r:…]] ids listed in the prompt's evidence. */
const evidenceIds = (msgs: WriterMessage[]) =>
  [...(msgs[0]?.content ?? '').matchAll(/- \[\[r:([^\]]+)\]\]/g)].map((m) => m[1]);

beforeAll(async () => {
  h = await createTestDb();
  s = await seed(h);
  for (const [date, title] of [
    ['2026-11-04', 'Fixed the release script'],
    ['2026-11-05', 'Reviewed the API design'],
  ] as const) {
    await ingestRecords(ctx('bob'), {
      source: 'test',
      tier: 'file_import',
      projectId: s.p.P,
      records: [
        {
          externalId: date,
          kind: 'note',
          eventTime: `${date}T15:00:00Z`,
          applicableDate: date,
          title,
          actor: 'me',
          url: 'https://x.test/1',
        },
      ],
    });
  }
});
afterAll(() => h.close());

describe('direct generation', () => {
  test('without a key it is refused, with a clear reason', async () => {
    const deps: GenerateDeps = { secrets: memorySecrets() };
    expect(await aiStatus(deps)).toEqual({ hasKey: false, model: 'claude-opus-5-5' });
    const r = await resolveReport(ctx('bob'), {
      projectId: s.p.P,
      kind: 'daily',
      date: '2026-11-04',
    });
    const e = (await generateReport(ctx('bob'), deps, r.reportId, { now: NOW }).catch(
      (x) => x,
    )) as ServiceError;
    expect(e).toBeInstanceOf(ServiceError);
    expect(e.data?.reason).toBe('direct_generation_disabled');
  });

  test('validation errors go back to the model, which fixes them', async () => {
    const secrets = memorySecrets();
    const script = scripted([
      () => '```markdown\n## Release\n- Fixed the release script\n```', // no citation
      (msgs) => `## Release\n- Fixed the release script [[r:${evidenceIds(msgs)[0]}]]`,
    ]);
    const deps: GenerateDeps = { secrets, writer: script.factory, model: 'fake-model' };
    await setApiKey(deps, { key: 'sk-ant-test-key-0123456789' });
    expect((await aiStatus(deps)).hasKey).toBe(true);

    const r = await resolveReport(ctx('bob'), {
      projectId: s.p.P,
      kind: 'daily',
      date: '2026-11-04',
    });
    const v = await generateReport(ctx('bob'), deps, r.reportId, { now: NOW });
    expect(v).toMatchObject({
      path: 'direct',
      client: 'xjournal',
      model: 'fake-model',
      versionNo: 1,
    });
    expect(v.bodyMd.startsWith('## Release')).toBe(true);
    // The second call saw the first draft and the validator's complaint.
    const second = script.seen[1] ?? [];
    expect(second.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    expect(second[2]?.content).toContain('unreferenced_statement');
    // The prompt carried the evidence, template and stats.
    const prompt = script.seen[0]?.[0]?.content ?? '';
    expect(prompt).toContain('Fixed the release script');
    expect(prompt).toContain("Write the day's work log");
    expect(prompt).toContain('[[s:notes]]');
  });

  test('it gives up after three bad attempts', async () => {
    const bad = () => '- No citations here';
    const script = scripted([bad, bad, bad]);
    const deps: GenerateDeps = {
      secrets: memorySecrets({ 'anthropic/api-key': 'sk-ant-test-key-0123456789' }),
      writer: script.factory,
    };
    const r = await resolveReport(ctx('bob'), {
      projectId: s.p.P,
      kind: 'daily',
      date: '2026-11-05',
    });
    const e = (await generateReport(ctx('bob'), deps, r.reportId, { now: NOW }).catch(
      (x) => x,
    )) as ServiceError;
    expect(e.code).toBe('validation_failed');
    expect(script.seen.length).toBe(3);
  });

  test('refresh writes every due report; export is portable Markdown', async () => {
    const script = scripted([
      (msgs) => `- ${'Reviewed the API design'} [[r:${evidenceIds(msgs)[0]}]]`,
      (msgs) => {
        const anchors = [
          ...(msgs[0]?.content ?? '').matchAll(
            /Input report: daily \S+ \(status \w+; cite statements as \[\[v:(\w+)#<anchor>\]\]\)\n- #(\S+):/g,
          ),
        ];
        return `## TL;DR\nA short week.\n## Shipped\n- Released the script [[v:${anchors[0]?.[1]}#${anchors[0]?.[2]}]]`;
      },
    ]);
    const deps: GenerateDeps = {
      secrets: memorySecrets({ 'anthropic/api-key': 'sk-ant-test-key-0123456789' }),
      writer: script.factory,
    };
    const r = await refreshReports(ctx('bob'), deps, s.p.P, NOW);
    expect(r.failed).toEqual([]);
    expect(r.written.map((w) => [w.kind, w.date])).toEqual([
      ['daily', '2026-11-05'],
      ['weekly', '2026-11-02'],
    ]);

    const md = await exportMarkdown(ctx('bob'), r.written[0]?.versionId as string);
    expect(md.filename).toBe('p-daily-2026-11-05-v1.md');
    expect(md.markdown).toMatch(/^---\nkind: daily\nproject: p\n/);
    expect(md.markdown).toContain('end_exclusive: 2026-11-06');
    expect(md.markdown).toContain('- Reviewed the API design [^1]');
    expect(md.markdown).toContain('[^1]: Reviewed the API design <https://x.test/1>');
    expect(md.markdown).not.toContain('[[r:');
  });
});
