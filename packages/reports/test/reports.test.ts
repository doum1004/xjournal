import { describe, expect, test } from 'bun:test';
import {
  citationsIn,
  type KnownRefs,
  periodFor,
  statementsOf,
  stripCitations,
  templateFor,
  validateReport,
} from '../src';

describe('citations and statements', () => {
  test('parses every citation type', () => {
    expect(citationsIn('a [[r:R1]] b [[v:V1#s123]] [[s:prs_merged]] [[w:W1]]')).toEqual([
      { type: 'r', id: 'R1', raw: '[[r:R1]]' },
      { type: 'v', id: 'V1', anchor: 's123', raw: '[[v:V1#s123]]' },
      { type: 's', id: 'prs_merged', raw: '[[s:prs_merged]]' },
      { type: 'w', id: 'W1', raw: '[[w:W1]]' },
    ]);
    expect(stripCitations('Fixed it [[r:R1]] [[r:R2]]')).toBe('Fixed it');
  });

  test('bullets, wrapped lines, nesting, paragraphs; headings, code and tables are not statements', () => {
    const body = [
      '---',
      'date: x',
      '---',
      '## SDK',
      '- Opened PRs:',
      '  - First [[r:A]]',
      '  - Second',
      '    wrapped [[r:B]]',
      '',
      'A paragraph [[r:C]]',
      '```',
      '- not a bullet',
      '```',
      '| a | b |',
      '## Notes',
      '1. Numbered [[r:D]]',
    ].join('\n');
    const st = statementsOf(body);
    expect(st.map((s) => [s.kind, s.depth, s.section, stripCitations(s.text)])).toEqual([
      ['bullet', 0, 'SDK', 'Opened PRs:'],
      ['bullet', 1, 'SDK', 'First'],
      ['bullet', 1, 'SDK', 'Second wrapped'],
      ['paragraph', 0, 'SDK', 'A paragraph'],
      ['bullet', 0, 'Notes', 'Numbered'],
    ]);
    expect(st[0]?.children.map((c) => c.line)).toEqual([6, 7]);
  });

  test('anchors are stable across versions and ignore citations, but differ by section', () => {
    const a = statementsOf('## SDK\n- Fixed the build [[r:A]]')[0]?.anchor;
    const b = statementsOf('## SDK\n- Fixed the build [[r:B]] \n- Another [[r:C]]')[0]?.anchor;
    const c = statementsOf('## CLI\n- Fixed the build [[r:A]]')[0]?.anchor;
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    const dup = statementsOf('- Same [[r:A]]\n- Same [[r:B]]').map((s) => s.anchor);
    expect(dup[1]).toBe(`${dup[0]}-2`);
  });
});

describe('validateReport', () => {
  const known = (over: Partial<KnownRefs> = {}): KnownRefs => ({
    revisions: new Map([
      ['R1', { applicableDate: '2026-11-04', visibleToAudience: true }],
      ['R2', { applicableDate: '2026-11-03', visibleToAudience: true }],
      ['RP', { applicableDate: '2026-11-04', visibleToAudience: false }],
    ]),
    versions: new Map([['V1', new Set(['sabc'])]]),
    workItems: new Set(),
    stats: new Set(['prs_merged']),
    period: { start: '2026-11-04', endExcl: '2026-11-05' },
    ...over,
  });

  test('a fully cited report passes and yields its refs', () => {
    const r = validateReport(
      '## SDK\n- Opened PRs:\n  - One [[r:R1]]\n- Merged 3 PRs [[s:prs_merged]] [[r:R1]]',
      known(),
    );
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.refs.map((x) => x.citation.raw)).toEqual(['[[r:R1]]', '[[s:prs_merged]]', '[[r:R1]]']);
  });

  test('each error code', () => {
    const body = [
      '## TL;DR',
      'A great day.',
      '## SDK',
      '- No evidence here',
      '- Unknown [[r:NOPE]]',
      '- Private [[r:RP]]',
      '- Yesterday [[r:R2]]',
      '- Fixed 4 bugs [[r:R1]]',
      '- A stat [[s:nope]]',
      '- Broken [[r:]]',
      '- Bad version [[v:V1#nope]]',
      '- Fine: PIX-1234, #215, v1.2 and 2026-11-04 [[r:R1]]',
      '- Fine too: the 2026.6 release shipped [[r:R1]]',
      '- Merged 1,200 commits [[r:R1]]',
    ].join('\n');
    const r = validateReport(body, known());
    expect(r.ok).toBe(false);
    expect(r.errors.map((e) => [e.code, e.text])).toEqual([
      ['unreferenced_statement', 'No evidence here'],
      ['unknown_ref', 'Unknown'],
      ['invisible_ref', 'Private'],
      ['out_of_period', 'Yesterday'],
      ['number_without_stat', 'Fixed 4 bugs'],
      ['unknown_stat', 'A stat'],
      ['malformed_ref', 'Broken [[r:]]'],
      ['unreferenced_statement', 'Broken [[r:]]'],
      ['unknown_ref', 'Bad version'],
      ['number_without_stat', 'Merged 1,200 commits'],
    ]);
    expect(r.errors.every((e) => e.hint.length > 10 && e.anchor && e.line)).toBe(true);
  });

  test('an empty body fails', () => {
    expect(validateReport('## Nothing\n', known()).errors.map((e) => e.code)).toEqual([
      'empty_report',
    ]);
  });
});

describe('periods', () => {
  test('daily, weekly (by week start), monthly, quarterly, yearly', () => {
    expect(periodFor('daily', '2026-11-04')).toEqual({
      start: '2026-11-04',
      endExcl: '2026-11-05',
      title: '2026-11-04 (Wednesday)',
    });
    expect(periodFor('weekly', '2026-11-04')).toMatchObject({
      start: '2026-11-02',
      endExcl: '2026-11-09',
    });
    expect(periodFor('weekly', '2026-11-04', { weekStart: 7 })).toMatchObject({
      start: '2026-11-01',
    });
    expect(periodFor('weekly', '2026-11-08')).toMatchObject({ start: '2026-11-02' }); // a Sunday
    expect(periodFor('monthly', '2026-12-15')).toEqual({
      start: '2026-12-01',
      endExcl: '2027-01-01',
      title: 'December 2026',
    });
    expect(periodFor('quarterly', '2026-11-04')).toMatchObject({
      start: '2026-10-01',
      endExcl: '2027-01-01',
      title: 'Q4 2026',
    });
    expect(periodFor('yearly', '2026-11-04')).toMatchObject({
      start: '2026-01-01',
      endExcl: '2027-01-01',
    });
  });

  test('bi-weekly pairs follow the anchor', () => {
    const a = periodFor('biweekly', '2026-11-04', { biweeklyAnchor: '2026-10-26' });
    const b = periodFor('biweekly', '2026-11-11', { biweeklyAnchor: '2026-10-26' });
    expect(a).toMatchObject({ start: '2026-10-26', endExcl: '2026-11-09' });
    expect(b).toMatchObject({ start: '2026-11-09', endExcl: '2026-11-23' });
  });

  test('templates carry the citation rules', () => {
    for (const k of ['daily', 'weekly', 'monthly', 'quarterly'] as const) {
      expect(templateFor(k).instructions).toContain('[[s:');
      expect(templateFor(k).version).toMatch(new RegExp(`^${k}@`));
    }
  });
});
