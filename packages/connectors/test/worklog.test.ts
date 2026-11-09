import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseDailyLog, parseFrontMatter, scanWorklog } from '../src';

// Synthetic logs in the prototype's format. Never real data: this repository is public.
const day = (date: string, body: string, source = 'confluence-import') =>
  `---\ndate: ${date}\nsource: ${source}\n---\n# ${date} (Monday)\n\n${body}\n`;

describe('parseFrontMatter', () => {
  test('reads simple key: value pairs and strips quotes', () => {
    const r = parseFrontMatter('---\nkind: weekly\ntitle: "W45 · a → b"\n---\nbody');
    expect(r.meta).toEqual({ kind: 'weekly', title: 'W45 · a → b' });
    expect(r.body).toBe('body');
  });
  test('no front matter: everything is body', () => {
    expect(parseFrontMatter('just text')).toEqual({ meta: {}, body: 'just text' });
  });
});

describe('parseDailyLog', () => {
  test('one log → one imported_log record dated by the log', () => {
    const text = day(
      '2026-03-09',
      '- Reviewed [the release plan](https://wiki.example.test/x) for PROJ-12\n  - Follow-up on PROJ-12 and OPS-7\n- Shipped https://git.example.test/acme/sdk/pull/5',
    );
    const r = parseDailyLog(
      text.replace(/\n/g, '\r\n'),
      'daily/2026/2026-03-09.md',
      'America/New_York',
    );
    if (!r.ok) throw new Error(r.reason);
    expect(r.record.source).toBe('confluence:worklog');
    expect(r.record.input).toMatchObject({
      externalId: '2026-03-09',
      kind: 'imported_log',
      applicableDate: '2026-03-09',
      // Midnight in New York, during daylight time (UTC−4) after the Mar 8 change.
      eventTime: '2026-03-09T04:00:00.000Z',
      title: 'Reviewed the release plan for PROJ-12',
      actor: 'worklog',
    });
    expect(r.record.input.summary?.startsWith('- Reviewed [the release plan]')).toBe(true);
    expect(r.record.input.payload).toMatchObject({
      file: 'daily/2026/2026-03-09.md',
      frontMatter: { date: '2026-03-09', source: 'confluence-import' },
      refs: {
        jira: ['PROJ-12', 'OPS-7'],
        urls: ['https://wiki.example.test/x', 'https://git.example.test/acme/sdk/pull/5'],
      },
    });
    // The date heading is dropped from the stored text.
    expect(String(r.record.input.payload?.text)).not.toContain('# 2026-03-09');
  });

  test('other sources are file imports; the file name is the fallback date', () => {
    const r = parseDailyLog('Plain text log, no front matter', 'daily/2025/2025-01-02.md', 'UTC');
    if (!r.ok) throw new Error(r.reason);
    expect(r.record.source).toBe('file:worklog');
    expect(r.record.input).toMatchObject({
      externalId: '2025-01-02',
      eventTime: '2025-01-02T00:00:00.000Z',
    });
  });

  test('long logs: title clipped to 120, summary to 2,000, full text kept in the payload', () => {
    const body = `- ${'a'.repeat(200)}\n${'- item\n'.repeat(400)}`;
    const r = parseDailyLog(day('2026-01-05', body), 'daily/2026/2026-01-05.md', 'UTC');
    if (!r.ok) throw new Error(r.reason);
    expect(r.record.input.title).toHaveLength(120);
    expect(r.record.input.summary).toHaveLength(2000);
    expect(String(r.record.input.payload?.text).length).toBeGreaterThan(2000);
  });

  test('rejects logs without a date or without content', () => {
    expect(parseDailyLog('text', 'daily/notes.md', 'UTC')).toEqual({
      ok: false,
      reason: 'no valid date',
    });
    expect(parseDailyLog(day('2026-01-05', ''), 'daily/2026/2026-01-05.md', 'UTC')).toEqual({
      ok: false,
      reason: 'empty log',
    });
  });
});

describe('scanWorklog', () => {
  let root: string;
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'worklog-'));
    mkdirSync(join(root, 'daily', '2025'), { recursive: true });
    mkdirSync(join(root, 'daily', '2026'), { recursive: true });
    mkdirSync(join(root, 'reviews', 'weekly'), { recursive: true });
    mkdirSync(join(root, 'raw'), { recursive: true });
    writeFileSync(join(root, 'daily', '2025', '2025-12-31.md'), day('2025-12-31', '- Year end'));
    writeFileSync(join(root, 'daily', '2026', '2026-01-02.md'), day('2026-01-02', '- New year'));
    writeFileSync(join(root, 'daily', '2026', '2026-01-03.md'), day('2026-01-03', ''));
    // A stray copy of an existing day under another year folder.
    writeFileSync(join(root, 'daily', '2026', '2025-12-31.md'), day('2025-12-31', '- Copy'));
    writeFileSync(join(root, 'daily', '2026', 'README.txt'), 'ignored');
    writeFileSync(join(root, 'reviews', 'weekly', '2026-W01.md'), '---\nkind: weekly\n---\n');
    writeFileSync(join(root, 'raw', 'x.json'), '{}');
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  test('finds dailies and reviews, reports skipped files, ignores raw/', () => {
    const s = scanWorklog(root, 'UTC');
    expect(s.daily.map((d) => [d.input.externalId, d.file])).toEqual([
      ['2025-12-31', 'daily/2025/2025-12-31.md'],
      ['2026-01-02', 'daily/2026/2026-01-02.md'],
    ]);
    expect(s.skipped).toEqual([
      { file: 'daily/2026/2026-01-03.md', reason: 'empty log' },
      { file: 'daily/2026/2025-12-31.md', reason: 'duplicate date 2025-12-31' },
    ]);
    expect(s.reviews).toEqual(['reviews/weekly/2026-W01.md']);
  });

  test('a missing folder is an error', () => {
    expect(() => scanWorklog(join(root, 'nope'), 'UTC')).toThrow('Not a folder');
  });
});
