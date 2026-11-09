import { describe, expect, test } from 'bun:test';
import {
  addDays,
  canonicalJson,
  contentHash,
  isIsoDate,
  localDate,
  noteTitleAndSummary,
  parseNoteHints,
} from '../src';

describe('parseNoteHints', () => {
  const today = '2026-11-08';

  test('reads projects, dates, kinds and tags, and strips them from the text', () => {
    const r = parseNoteHints('Shipped the fix #SDK @yesterday !decision !Win.', today);
    expect(r.hints).toEqual({
      projects: ['sdk'],
      date: '2026-11-07',
      tags: ['decision', 'win'],
      invalid: [],
    });
    expect(r.clean).toBe('Shipped the fix.');
  });

  test('!event, !context, !guidance and !reminder are kinds, not tags', () => {
    const r = parseNoteHints('Background !context', today);
    expect(r.hints.kind).toBe('context');
    expect(r.hints.tags).toEqual([]);
  });

  test('dates: today, yesterday, ISO; anything else stays in the text', () => {
    expect(parseNoteHints('a @today', today).hints.date).toBe(today);
    expect(parseNoteHints('a @2026-02-28', today).hints.date).toBe('2026-02-28');
    const r = parseNoteHints('ask @alice about @2026-02-30', today);
    expect(r.hints.date).toBeUndefined();
    expect(r.hints.invalid).toEqual(['alice', '2026-02-30']);
    expect(r.clean).toBe('ask @alice about @2026-02-30');
  });

  test('ignores # and @ inside words, emails and URLs', () => {
    const r = parseNoteHints('mail a@b.com, see https://x.test/#frag and C#', today);
    expect(r.hints.projects).toEqual([]);
    expect(r.hints.invalid).toEqual([]);
    expect(r.clean).toBe('mail a@b.com, see https://x.test/#frag and C#');
  });

  test('deduplicates projects and tags; keeps line breaks', () => {
    const r = parseNoteHints('#a #a !x !x\nsecond   line', today);
    expect(r.hints.projects).toEqual(['a']);
    expect(r.hints.tags).toEqual(['x']);
    expect(r.clean).toBe('second line');
  });
});

describe('noteTitleAndSummary', () => {
  test('one line: title only', () => {
    expect(noteTitleAndSummary('Short', 'Short #p')).toEqual({ title: 'Short' });
  });
  test('several lines: first line is the title, the whole text the summary', () => {
    expect(noteTitleAndSummary('One\nTwo', 'One\nTwo')).toEqual({
      title: 'One',
      summary: 'One\nTwo',
    });
  });
  test('long text is truncated', () => {
    const r = noteTitleAndSummary('x'.repeat(400), 'x'.repeat(400));
    expect(r.title).toHaveLength(300);
    expect(r.title.endsWith('…')).toBe(true);
  });
  test('only hints: falls back to the raw text', () => {
    expect(noteTitleAndSummary('', '#p !win')).toEqual({ title: '#p !win' });
  });
});

describe('time', () => {
  test('localDate follows the time zone', () => {
    const t = new Date('2026-11-08T03:00:00Z');
    expect(localDate(t, 'UTC')).toBe('2026-11-08');
    expect(localDate(t, 'America/New_York')).toBe('2026-11-07');
    expect(localDate(t, 'Asia/Seoul')).toBe('2026-11-08');
  });
  test('addDays crosses months and years', () => {
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
  });
  test('isIsoDate rejects impossible dates', () => {
    expect(isIsoDate('2024-02-29')).toBe(true);
    expect(isIsoDate('2026-02-29')).toBe(false);
    expect(isIsoDate('2026-1-01')).toBe(false);
  });
});

describe('hashing', () => {
  test('key order does not change the hash; undefined fields are dropped', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}');
    expect(contentHash({ a: 1, b: undefined })).toBe(contentHash({ a: 1 }));
    expect(contentHash({ a: 1 })).toMatch(/^[0-9a-f]{64}$/);
  });
});
