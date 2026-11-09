import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { DbHandle } from '@xjournal/db';
import { createTestDb } from '@xjournal/db/testing';
import { type Seed, seed } from '../../db/test/fixtures';
import {
  addGuidance,
  type Ctx,
  getReport,
  getReportInputs,
  getStatus,
  ingestRecords,
  listReports,
  listReportVersions,
  markStaleReports,
  resolveReport,
  ServiceError,
  saveReportVersion,
} from '../src';

const NOW = new Date('2026-11-09T12:00:00Z'); // Monday 07:00 in New York

let h: DbHandle;
let s: Seed;
const ctx = (user: keyof Seed['u']): Ctx => ({
  db: h.db,
  actor: { userId: s.u[user], workspaceId: s.ws.W },
});

async function err(p: Promise<unknown>) {
  const e = await p.then(
    () => null,
    (x: unknown) => x,
  );
  expect(e).toBeInstanceOf(ServiceError);
  return e as ServiceError;
}

async function put(user: keyof Seed['u'], date: string, title: string, visibility?: 'project') {
  const r = await ingestRecords(ctx(user), {
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
  if (visibility) {
    // Make it project-visible through routing.
    const { routeRecord, search } = await import('../src');
    const found = await search(ctx(user), { q: title, projectId: s.p.P });
    await routeRecord(ctx(user), found.items[0]?.id as string, { visibility });
  }
  return r;
}

beforeAll(async () => {
  h = await createTestDb();
  s = await seed(h);
  await put('bob', '2026-11-04', 'Fixed the flaky test');
  await put('bob', '2026-11-04', 'Shipped the release');
  await put('bob', '2026-11-05', 'Planned the next sprint');
});
afterAll(() => h.close());

let dailyId = '';
let firstHash = '';

describe('daily report', () => {
  test('resolve finds or creates the logical report; viewers cannot start one', async () => {
    const a = await resolveReport(ctx('bob'), {
      projectId: s.p.P,
      kind: 'daily',
      date: '2026-11-04',
    });
    const b = await resolveReport(ctx('bob'), {
      projectId: s.p.P,
      kind: 'daily',
      date: '2026-11-04',
    });
    expect(a.reportId).toBe(b.reportId);
    expect(a).toMatchObject({
      kind: 'daily',
      period: { start: '2026-11-04', endExcl: '2026-11-05', title: '2026-11-04 (Wednesday)' },
      audienceKey: `me:${s.u.bob}`,
      currentVersionId: null,
    });
    dailyId = a.reportId;
    expect(
      (
        await err(
          resolveReport(ctx('carol'), { projectId: s.p.P, kind: 'daily', date: '2026-11-04' }),
        )
      ).status,
    ).toBe(403);
  });

  test('inputs: the day’s bundle, template, stats, citation format and a hash', async () => {
    const i = await getReportInputs(ctx('bob'), dailyId, NOW);
    expect(i.bundles?.[0]?.unlinked.map((r) => r.title).sort()).toEqual([
      'Fixed the flaky test',
      'Shipped the release',
    ]);
    expect(i.bundles?.[0]?.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(i.template.version).toBe('daily@1');
    expect(i.stats.find((x) => x.metric === 'notes')?.value).toBe(2);
    expect(i.refFormat).toContain('[[r:');
    expect(i.inputHash).toMatch(/^[0-9a-f]{64}$/);
    firstHash = i.inputHash;
  });

  test('a bad body is rejected with validation errors; a wrong hash is stale_input', async () => {
    const i = await getReportInputs(ctx('bob'), dailyId, NOW);
    const bad = await err(
      saveReportVersion(
        ctx('bob'),
        dailyId,
        { bodyMd: '## Work\n- Did 3 tests\n- Unknown [[r:nope]]', inputHash: i.inputHash },
        NOW,
      ),
    );
    expect(bad.status).toBe(422);
    expect(((bad.data?.validation ?? []) as { code: string }[]).map((e) => e.code)).toEqual([
      'unreferenced_statement',
      'number_without_stat',
      'unknown_ref',
    ]);
    const stale = await err(
      saveReportVersion(ctx('bob'), dailyId, { bodyMd: '- x', inputHash: 'old' }, NOW),
    );
    expect(stale).toMatchObject({ status: 409, code: 'stale_input' });
  });

  test('a cited body is saved; citations expand; later versions need a change summary', async () => {
    const i = await getReportInputs(ctx('bob'), dailyId, NOW);
    const [a, b] = i.bundles?.[0]?.unlinked ?? [];
    const body = `## Work\n- ${a?.title} [[r:${a?.revisionId}]]\n- ${b?.title} [[r:${b?.revisionId}]]\n- Wrote 2 notes [[s:notes]]`;
    const v1 = await saveReportVersion(
      ctx('bob'),
      dailyId,
      {
        bodyMd: body,
        inputHash: i.inputHash,
        generator: { path: 'agent', client: 'test', model: 'm' },
      },
      NOW,
    );
    expect(v1).toMatchObject({
      versionNo: 1,
      changeReason: 'initial',
      status: 'current',
      client: 'test',
    });
    expect(
      v1.citations
        .filter((c) => c.type === 'record_revision')
        .map((c) => c.title)
        .sort(),
    ).toEqual(['Fixed the flaky test', 'Shipped the release']);
    expect(v1.citations.find((c) => c.type === 'stat')?.title).toBe('notes = 2');

    const again = await getReportInputs(ctx('bob'), dailyId, NOW);
    expect(again.previous?.versionId).toBe(v1.versionId);
    const noSummary = await err(
      saveReportVersion(ctx('bob'), dailyId, { bodyMd: body, inputHash: again.inputHash }, NOW),
    );
    expect(noSummary.status).toBe(400);
    const v2 = await saveReportVersion(
      ctx('bob'),
      dailyId,
      {
        bodyMd: body.replace('## Work', '## SDK'),
        inputHash: again.inputHash,
        changeSummary: 'Renamed the area',
      },
      NOW,
    );
    expect(v2).toMatchObject({ versionNo: 2, changeReason: 'editorial' });
    expect((await listReportVersions(ctx('bob'), dailyId)).map((v) => v.versionNo)).toEqual([2, 1]);
    expect(
      (await getReport(ctx('bob'), { projectId: s.p.P, kind: 'daily', date: '2026-11-04' }))
        .versionId,
    ).toBe(v2.versionId);
  });

  test('others cannot read a personal report', async () => {
    const v = await getReport(ctx('bob'), { projectId: s.p.P, kind: 'daily', date: '2026-11-04' });
    expect((await err(getReport(ctx('dave'), { versionId: v.versionId }))).status).toBe(404);
  });
});

describe('staleness and period reports', () => {
  let weeklyId = '';

  test('a weekly report cites the daily report’s statements', async () => {
    await resolveReport(ctx('bob'), { projectId: s.p.P, kind: 'daily', date: '2026-11-05' });
    const w = await resolveReport(ctx('bob'), {
      projectId: s.p.P,
      kind: 'weekly',
      date: '2026-11-04',
    });
    weeklyId = w.reportId;
    expect(w.period).toMatchObject({ start: '2026-11-02', endExcl: '2026-11-09' });
    const i = await getReportInputs(ctx('bob'), weeklyId, NOW);
    expect(i.inputReports?.length).toBe(1);
    // Weekdays without a daily report, up to today.
    expect(i.gaps.missingDays).toEqual(['2026-11-02', '2026-11-03', '2026-11-05', '2026-11-06']);
    const ir = i.inputReports?.[0];
    const st = ir?.statements[0];
    const v = await saveReportVersion(
      ctx('bob'),
      weeklyId,
      {
        bodyMd: `## TL;DR\nA steady week.\n## Shipped\n- ${st?.text} [[v:${ir?.versionId}#${st?.anchor}]]`,
        inputHash: i.inputHash,
      },
      NOW,
    );
    expect(v.status).toBe('current');
  });

  test('new evidence makes the daily stale, and staleness climbs to the weekly', async () => {
    await put('bob', '2026-11-04', 'A late note');
    const { rebuildBundles } = await import('../src');
    await rebuildBundles(h.db, { now: NOW });
    expect(await markStaleReports(h.db)).toBeGreaterThanOrEqual(1);
    const daily = await getReport(ctx('bob'), {
      projectId: s.p.P,
      kind: 'daily',
      date: '2026-11-04',
    });
    expect(daily.status).toBe('stale');
    const i = await getReportInputs(ctx('bob'), dailyId, NOW);
    expect(i.inputHash).not.toBe(firstHash);

    // Rewriting the daily (a factual change) makes the weekly stale.
    const rows = i.bundles?.[0]?.unlinked ?? [];
    const body = rows.map((r) => `- ${r.title} [[r:${r.revisionId}]]`).join('\n');
    const v3 = await saveReportVersion(
      ctx('bob'),
      dailyId,
      { bodyMd: body, inputHash: i.inputHash, changeSummary: 'Added the late note' },
      NOW,
    );
    expect(v3.changeReason).toBe('factual');
    const weekly = await getReport(ctx('bob'), {
      projectId: s.p.P,
      kind: 'weekly',
      date: '2026-11-04',
    });
    expect(weekly.status).toBe('stale');
  });

  test('guidance shows up in the inputs and changes their hash', async () => {
    const before = (await getReportInputs(ctx('bob'), dailyId, NOW)).inputHash;
    await addGuidance(ctx('dave'), { scope: 'project', projectId: s.p.P, text: 'Keep it short.' });
    expect(
      (await err(addGuidance(ctx('bob'), { scope: 'project', projectId: s.p.P, text: 'x' })))
        .status,
    ).toBe(403);
    const i = await getReportInputs(ctx('bob'), dailyId, NOW);
    expect(i.guidance.map((g) => g.text)).toEqual(['Keep it short.']);
    expect(i.inputHash).not.toBe(before);
  });

  test('a project-wide report only sees project-visible records', async () => {
    await put('bob', '2026-11-06', 'Shared with the team', 'project');
    await put('bob', '2026-11-06', 'Only mine');
    const r = await resolveReport(ctx('dave'), {
      projectId: s.p.P,
      kind: 'daily',
      date: '2026-11-06',
      audience: 'project',
    });
    const i = await getReportInputs(ctx('dave'), r.reportId, NOW);
    expect(i.report.audience.length).toBe(4); // alice, bob, carol, dave
    // dave sees bob's project-visible note; bob's private one is in no shared input.
    expect(i.bundles?.[0]?.unlinked.map((x) => x.title)).toEqual(['Shared with the team']);
  });
});

describe('status', () => {
  test('due: missing weekdays with evidence, stale reports, last week’s review', async () => {
    const st = await getStatus(ctx('bob'), { now: NOW });
    const due = st.due.filter((d) => d.projectId === s.p.P).map((d) => [d.kind, d.date, d.reason]);
    expect(due).toContainEqual(['daily', '2026-11-05', 'missing']);
    expect(due).toContainEqual(['daily', '2026-11-06', 'missing']);
    expect(due).toContainEqual(['weekly', '2026-11-02', 'stale']);
    expect(due).not.toContainEqual(['daily', '2026-11-04', 'missing']);
    expect(st.projects.map((p) => p.slug)).toContain('p');
    const reports = await listReports(ctx('bob'), s.p.P, { from: '2026-11-01', to: '2026-11-10' });
    expect(reports.map((r) => [r.kind, r.period.start])).toContainEqual(['weekly', '2026-11-02']);
  });
});
