import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { ReportKind } from '@xjournal/core';
import type { DbHandle } from '@xjournal/db';
import { createTestDb } from '@xjournal/db/testing';
import { type Seed, seed } from '../../db/test/fixtures';
import {
  type Ctx,
  careerSection,
  createCareerEntry,
  deleteCareerEntry,
  exportCareer,
  getReport,
  getReportInputs,
  getStatus,
  importCareer,
  ingestRecords,
  listCareer,
  parseExperience,
  publicSafeWarnings,
  resolveReport,
  ServiceError,
  saveReportVersion,
  updateCareerEntry,
  updateWorkspace,
} from '../src';

// Bi-weekly, quarterly and yearly reports (spec §5.3–5.6) and the career log (spec §9.8).
// The default bi-weekly anchor (2024-01-01) pairs 2026-10-05 + 10-12 and 10-19 + 10-26.

const NOW = new Date('2026-11-09T12:00:00Z');

let h: DbHandle;
let s: Seed;
const ctx = (user: keyof Seed['u']): Ctx => ({
  db: h.db,
  actor: { userId: s.u[user], workspaceId: s.ws.W },
});

async function note(date: string, title: string) {
  await ingestRecords(ctx('bob'), {
    source: 'test',
    tier: 'file_import',
    projectId: s.p.P,
    records: [
      {
        externalId: `${date}-${title}`,
        kind: 'note',
        eventTime: `${date}T15:00:00Z`,
        applicableDate: date,
        title,
        actor: 'me',
      },
    ],
  });
}

type Inputs = Awaited<ReturnType<typeof getReportInputs>>;

/** Write a report for the period around `date`, citing every input statement, plus `extra`. */
async function write(
  kind: ReportKind,
  date: string,
  extra?: (i: Inputs) => string,
  changeSummary?: string,
) {
  const r = await resolveReport(ctx('bob'), { projectId: s.p.P, kind, date });
  const i = await getReportInputs(ctx('bob'), r.reportId, NOW);
  const lines =
    kind === 'daily'
      ? (i.bundles?.[0]?.unlinked ?? []).map((x) => `- ${x.title} [[r:${x.revisionId}]]`)
      : (i.inputReports ?? []).flatMap((ir) =>
          ir.statements.map((st) => `- ${st.text} [[v:${ir.versionId}#${st.anchor}]]`),
        );
  const v = await saveReportVersion(
    ctx('bob'),
    r.reportId,
    {
      bodyMd: `## Work\n${lines.join('\n')}${extra ? `\n${extra(i)}` : ''}`,
      inputHash: i.inputHash,
      ...(changeSummary ? { changeSummary } : {}),
    },
    NOW,
  );
  return { report: r, inputs: i, version: v };
}

beforeAll(async () => {
  h = await createTestDb();
  s = await seed(h);
  await note('2026-10-06', 'Started the exporter');
  await note('2026-10-20', 'Shipped the exporter');
});
afterAll(() => h.close());

describe('bi-weekly', () => {
  let firstBiweekly = '';

  test('is built from its weekly reports and lists the weeks it lacks', async () => {
    await write('daily', '2026-10-06');
    await write('weekly', '2026-10-06');
    const b = await write(
      'biweekly',
      '2026-10-06',
      (i) =>
        `## Next two weeks\n- Ship the exporter [[v:${i.inputReports?.[0]?.versionId}#${i.inputReports?.[0]?.statements[0]?.anchor}]]`,
    );
    firstBiweekly = b.version.versionId;
    expect(b.report.period).toMatchObject({ start: '2026-10-05', endExcl: '2026-10-19' });
    expect(b.inputs.inputReports?.map((x) => x.kind)).toEqual(['weekly']);
    expect(b.inputs.gaps.missingInputs?.map((m) => m.start)).toEqual(['2026-10-12']);
    expect(b.inputs.previousPeriod).toBeUndefined();
    expect(b.inputs.template.version).toBe('biweekly@3');
  });

  test('gets the previous bi-weekly for plan vs. actual, and may cite it', async () => {
    await write('daily', '2026-10-20');
    await write('weekly', '2026-10-20');
    const b = await write('biweekly', '2026-10-20', (i) => {
      const pp = i.previousPeriod;
      const plan = pp?.statements.find((x) => x.text.startsWith('Ship the exporter'));
      return `## Plan vs. actual\n- ✅ Ship the exporter [[v:${pp?.versionId}#${plan?.anchor}]]`;
    });
    expect(b.inputs.previousPeriod?.versionId).toBe(firstBiweekly);
    expect(b.inputs.previousPeriod?.period.start).toBe('2026-10-05');
    expect(b.version.status).toBe('current');
  });

  test('a new version of the previous bi-weekly makes the next one stale', async () => {
    await write('biweekly', '2026-10-06', () => '## Next two weeks', 'Reworded');
    const next = await getReport(ctx('bob'), {
      projectId: s.p.P,
      kind: 'biweekly',
      date: '2026-10-20',
    });
    expect(next.status).toBe('stale');
  });

  test('the anchor comes from the workspace settings', async () => {
    await updateWorkspace(ctx('alice'), { biweeklyAnchor: '2026-10-12' });
    const r = await resolveReport(ctx('bob'), {
      projectId: s.p.P,
      kind: 'biweekly',
      date: '2026-10-20',
    });
    expect(r.period).toMatchObject({ start: '2026-10-12', endExcl: '2026-10-26' });
    await updateWorkspace(ctx('alice'), { biweeklyAnchor: '2024-01-01' });
  });
});

describe('quarterly and the career log', () => {
  const CAREER = (i: Inputs) => {
    const ir = i.inputReports?.[0];
    const c = `[[v:${ir?.versionId}#${ir?.statements[0]?.anchor}]]`;
    return `## Career log\n- Built and shipped a model exporter (PIX-12) ${c}\n- Skills: TypeScript, Postgres ${c}\n## Notes\n- Done ${c}`;
  };

  test('due lists the last bi-weekly once its weeks have reports', async () => {
    const due = (await getStatus(ctx('bob'), { now: NOW })).due.map((d) => [d.kind, d.date]);
    expect(due).toContainEqual(['biweekly', '2026-10-19']);
    expect(due).toContainEqual(['monthly', '2026-10-01']);
    expect(due).not.toContainEqual(['quarterly', '2026-07-01']); // no monthly reports in Q3
  });

  test('a quarterly is built from monthly reports and proposes a career log draft', async () => {
    await write('monthly', '2026-10-15');
    const q = await write('quarterly', '2026-10-15', CAREER);
    expect(q.inputs.inputReports?.map((x) => x.kind)).toEqual(['monthly']);
    expect(q.inputs.gaps.missingInputs).toEqual([]); // November isn't over yet
    expect(q.inputs.template.sections).toContain('Career log');

    const [entry] = await listCareer(ctx('bob'));
    expect(entry).toMatchObject({
      title: 'Q4 2026',
      periodStart: '2026-10-01',
      status: 'draft',
      sourceVersionId: q.version.versionId,
      bodyMd: '- Built and shipped a model exporter (PIX-12)\n- Skills: TypeScript, Postgres',
    });
    expect(entry?.warnings).toEqual([{ line: 1, text: 'PIX-12', reason: 'an issue key' }]);
    expect(await listCareer(ctx('dave'))).toEqual([]); // private to its owner
  });

  test('a rewrite updates a draft; an approved entry is kept; edits go back to draft', async () => {
    const [entry] = await listCareer(ctx('bob'));
    const id = entry?.id as string;
    const approved = await updateCareerEntry(ctx('bob'), id, {
      bodyMd: '- Built and shipped a model exporter\n- Skills: TypeScript, Postgres',
      status: 'approved',
    });
    expect(approved).toMatchObject({ status: 'approved', warnings: [] });
    expect(approved.approvedAt).not.toBeNull();

    await write('quarterly', '2026-10-15', CAREER, 'Rewrote');
    expect((await listCareer(ctx('bob')))[0]?.bodyMd).toBe(approved.bodyMd);

    const edited = await updateCareerEntry(ctx('bob'), id, { bodyMd: '- Something else' });
    expect(edited).toMatchObject({ status: 'draft', approvedAt: null });
    await updateCareerEntry(ctx('bob'), id, { bodyMd: approved.bodyMd, status: 'approved' });

    const e = await updateCareerEntry(ctx('dave'), id, { status: 'draft' }).catch((x) => x);
    expect(e).toBeInstanceOf(ServiceError);
    expect((e as ServiceError).status).toBe(404);
  });

  test('export: approved quarters, newest first', async () => {
    await createCareerEntry(ctx('bob'), {
      projectId: s.p.P,
      date: '2026-08-10',
      bodyMd: '- Ran the release',
    });
    const approvedOnly = await exportCareer(ctx('bob'), {});
    expect(approvedOnly.markdown).toBe(
      '# Career log\n\n## Q4 2026\n- Built and shipped a model exporter\n- Skills: TypeScript, Postgres\n',
    );
    const all = await exportCareer(ctx('bob'), { drafts: 'true' });
    expect(all.count).toBe(2);
    expect(all.markdown.indexOf('## Q4 2026')).toBeLessThan(all.markdown.indexOf('## Q3 2026'));
    const dup = await createCareerEntry(ctx('bob'), {
      projectId: s.p.P,
      date: '2026-09-01',
      bodyMd: '- Again',
    }).catch((x) => x);
    expect((dup as ServiceError).status).toBe(409);
  });

  test('the prototype’s experience.md imports as approved quarters, once', async () => {
    const md =
      '# Experience\n\n## Q2 2026\n- Led the SDK release\nSkills: C++, Python\n\n## Q3 2026\n- Already here\n';
    expect(parseExperience(md)).toEqual([
      { date: '2026-04-01', bodyMd: '- Led the SDK release\nSkills: C++, Python' },
      { date: '2026-07-01', bodyMd: '- Already here' },
    ]);
    expect(await importCareer(ctx('bob'), s.p.P, md)).toEqual({ created: 1, skipped: 1 });
    expect(await importCareer(ctx('bob'), s.p.P, md)).toEqual({ created: 0, skipped: 2 });
    const q2 = (await listCareer(ctx('bob'))).find((x) => x.title === 'Q2 2026');
    expect(q2?.status).toBe('approved');
    await deleteCareerEntry(ctx('bob'), q2?.id as string);
    expect((await listCareer(ctx('bob'))).length).toBe(2);
  });
});

describe('career helpers', () => {
  test('careerSection takes the section and drops citations', () => {
    expect(
      careerSection('## TL;DR\nx\n## Career log\n- A [[v:1#a]]\n- B [[r:2]]  \n## Next\n- c'),
    ).toBe('- A\n- B');
    expect(careerSection('## TL;DR\nx')).toBeNull();
  });

  test('publicSafeWarnings flags what a public profile must not carry', () => {
    const reasons = (t: string) => publicSafeWarnings(t).map((w) => w.reason);
    expect(reasons('- Fixed PIX-1234 on build.cds.internal')).toEqual([
      'an issue key',
      'an internal hostname',
    ]);
    expect(reasons('- See https://example.com, 10.0.0.1')).toEqual(['a link', 'an IP address']);
    expect(reasons('- Saved $2M, grew the team to 12 engineers')).toEqual([
      'a financial figure',
      'a headcount figure',
    ]);
    expect(reasons('- Led CI/CD for Unity 6 and C++ 17 builds')).toEqual([]);
  });
});
