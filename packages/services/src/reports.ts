import {
  addDays,
  type CitationView,
  type Coverage,
  contentHash,
  isIsoDate,
  localDate,
  newId,
  type RecordView,
  type ReportInputs,
  type ReportKind,
  type ReportRef,
  type ReportVersionView,
  reportKinds,
  type StatView,
  zIsoDate,
} from '@xjournal/core';
import {
  bundleRepo,
  type HubDb,
  projectRepo,
  type RecordRow,
  type ReportRow,
  type ReportVersionRow,
  reportRepo,
  type Tx,
  withSystem,
} from '@xjournal/db';
import {
  inputKindOf,
  type KnownRefs,
  periodFor,
  REF_FORMAT,
  statementsOf,
  stripCitations,
  templateFor,
  validateReport,
} from '@xjournal/reports';
import { z } from 'zod';
import { buildBundle } from './bundles';
import { asCaller, type Ctx } from './context';
import { conflict, forbidden, isUniqueViolation, notFound, parse, ServiceError } from './errors';
import { atLeast, workspaceTimeZone } from './projects';
import { toViews } from './records';

// Reports (spec §4 Layer 3, §5–6; api.md §3.5, §4): resolve the logical report, assemble its
// inputs filtered to what every reader may see, validate and store versions, and propagate
// staleness. The same inputs and validator serve the agent path (MCP) and, later, the direct
// path (M4).

const zKind = z.enum(reportKinds);
const zAudience = z.enum(['me', 'project']).default('me');

export const zResolveInput = z.object({
  projectId: z.string().min(1),
  kind: zKind,
  date: zIsoDate,
  audience: zAudience,
});

const audienceKeyOf = (a: 'me' | 'project', userId: string) =>
  a === 'project' ? 'project' : `me:${userId}`;

const STAT_TEXT: Record<string, string> = {
  prs_opened: 'Pull requests you opened',
  prs_merged: 'Your pull requests merged',
  reviews: 'Reviews you gave on others’ pull requests',
  commits: 'Commits you pushed (outside shared branches)',
  code_comments: 'Your code review and commit comments',
  issues_created: 'Issues you created',
  issue_changes: 'Your issue changes (status, fields)',
  issue_comments: 'Your issue and PR conversation comments',
  pages_edited: 'Wiki pages you created or edited',
  page_comments: 'Your wiki comments',
  meetings: 'Meetings',
  notes: 'Your notes',
  active_days: 'Days with any activity',
};

function toRef(r: ReportRow, title: string): ReportRef {
  return {
    reportId: r.id,
    kind: r.kind,
    projectId: r.projectId,
    period: { start: r.periodStart, endExcl: r.periodEndExcl, title },
    audienceKey: r.audienceKey,
    status: r.status,
    currentVersionId: r.currentVersionId,
  };
}

async function weekStartOf(tx: Tx): Promise<number> {
  return (await projectRepo.getWorkspaceSettings(tx))?.weekStart ?? 1;
}

const titleOf = async (tx: Tx, r: ReportRow) =>
  periodFor(r.kind, r.periodStart, { weekStart: await weekStartOf(tx) }).title;

/** `POST /projects/{p}/reports/resolve`: find or create the logical report. */
export async function resolveReport(ctx: Ctx, input: unknown): Promise<ReportRef> {
  const req = parse(zResolveInput, input);
  return asCaller(ctx, async (tx) => {
    const project = await projectRepo.findProject(tx, req.projectId);
    if (!project) throw notFound('Project not found');
    const weekStart = await weekStartOf(tx);
    const period = periodFor(req.kind, req.date, { weekStart });
    const audienceKey = audienceKeyOf(req.audience, ctx.actor.userId);
    const key = { projectId: project.id, kind: req.kind, periodStart: period.start, audienceKey };
    const existing = await reportRepo.findReport(tx, key);
    if (existing) return toRef(existing, period.title);
    if (!atLeast(project.role, 'contributor')) {
      throw forbidden('You need at least contributor rights in this project to start a report');
    }
    const audience =
      req.audience === 'project'
        ? await reportRepo.projectMemberIds(tx, project.id)
        : [ctx.actor.userId];
    const id = newId();
    try {
      await reportRepo.insertReport(
        tx,
        {
          id,
          workspaceId: ctx.actor.workspaceId,
          projectId: project.id,
          kind: req.kind,
          periodStart: period.start,
          periodEndExcl: period.endExcl,
          audienceKey,
        },
        audience,
      );
    } catch (e) {
      if (isUniqueViolation(e))
        throw conflict('That report exists, but you are not in its audience');
      throw e;
    }
    const row = await reportRepo.getReport(tx, id);
    if (!row) throw new ServiceError(500, 'internal', 'Report not readable after create');
    return toRef(row, period.title);
  });
}

// ------------------------------------------------------------------------------------------
// Inputs (api.md §4.1)
// ------------------------------------------------------------------------------------------

interface Built {
  inputs: ReportInputs;
  known: KnownRefs;
  inputRows: { inputType: string; inputId: string; inputHash: string }[];
  guidanceHash: string;
  statRows: Map<string, { query: unknown; value: number }>;
  previous: ReportVersionRow | null;
}

/** Bring the bundles of a report's period up to date first (system), so inputs are fresh. */
async function freshenBundles(db: HubDb, report: ReportRow, now: Date) {
  const [p] = (await withSystem(db, (tx) => bundleRepo.allProjects(tx))).filter(
    (x) => x.id === report.projectId,
  );
  if (!p) return;
  const today = localDate(now, p.timeZone);
  const stale = new Set(await withSystem(db, (tx) => bundleRepo.staleDays(tx, p.id)));
  for (let d = report.periodStart; d < report.periodEndExcl && d <= today; d = addDays(d, 1)) {
    if (stale.has(d) || report.kind === 'daily') await buildBundle(db, p, d, now);
  }
}

async function buildInputs(tx: Tx, ctx: Ctx, report: ReportRow, now: Date): Promise<Built> {
  if (!report.projectId)
    throw new ServiceError(400, 'bad_request', 'Workspace reports arrive later');
  const projectId = report.projectId;
  const weekStart = await weekStartOf(tx);
  const period = periodFor(report.kind, report.periodStart, { weekStart });
  const audience = await reportRepo.audienceOf(tx, report.id);
  const onlyMe = audience.length === 1 && audience[0]?.id === ctx.actor.userId;
  // What every reader may see (spec §9.4): for a personal report, all the caller sees; for a
  // shared one, only project-visible records.
  const forAudience = (rows: RecordRow[]) =>
    onlyMe ? rows : rows.filter((r) => r.visibility === 'project');

  const rows = forAudience(
    await reportRepo.recordsInRange(tx, projectId, report.periodStart, report.periodEndExcl),
  );
  const views = await toViews(tx, ctx, rows);
  const known: KnownRefs = {
    revisions: new Map(
      rows.map((r) => [
        r.currentRevisionId,
        { applicableDate: r.applicableDate, visibleToAudience: true },
      ]),
    ),
    versions: new Map(),
    workItems: new Set(),
    stats: new Set(),
    period: { start: report.periodStart, endExcl: report.periodEndExcl },
  };
  const inputRows: Built['inputRows'] = [];

  const bundles = await bundleRepo.bundlesInRange(
    tx,
    projectId,
    report.periodStart,
    addDays(report.periodEndExcl, -1),
  );
  const coverage: Coverage = {};
  for (const b of bundles) {
    inputRows.push({ inputType: 'bundle', inputId: b.id, inputHash: b.contentHash });
    for (const [k, v] of Object.entries(b.coverage as Coverage)) {
      // The period's worst coverage per connector.
      const order = ['complete', 'pending', 'error', 'truncated'];
      const prev = coverage[k];
      if (!prev || order.indexOf(v.status) > order.indexOf(prev.status)) coverage[k] = v;
    }
  }

  const inputs: ReportInputs = {
    report: { ...toRef(report, period.title), audience },
    template: templateFor(report.kind),
    guidance: [],
    stats: [],
    gaps: { missingDays: [], staleInputs: [], coverage },
    refFormat: REF_FORMAT,
    inputHash: '',
  };

  if (report.kind === 'daily') {
    const b = bundles[0];
    inputs.bundles = [
      {
        date: report.periodStart,
        hash: b?.contentHash ?? '',
        coverage: (b?.coverage ?? {}) as Coverage,
        workItems: [],
        unlinked: views,
      },
    ];
  } else {
    const fromKind = inputKindOf(report.kind) as ReportKind;
    const dailies = (
      await reportRepo.reportsInRange(tx, {
        projectId,
        kind: fromKind,
        from: report.periodStart,
        toExcl: report.periodEndExcl,
        audienceKey: report.audienceKey,
      })
    ).filter((d) => d.report.currentVersionId && d.bodyMd != null);
    inputs.inputReports = dailies.map((d) => {
      const statements = statementsOf(d.bodyMd ?? '');
      known.versions.set(
        d.report.currentVersionId as string,
        new Set(statements.map((s) => s.anchor)),
      );
      inputRows.push({
        inputType: 'report_version',
        inputId: d.report.currentVersionId as string,
        inputHash: d.report.currentVersionId as string,
      });
      return {
        versionId: d.report.currentVersionId as string,
        kind: d.report.kind,
        period: { start: d.report.periodStart, endExcl: d.report.periodEndExcl },
        bodyMd: d.bodyMd ?? '',
        status: d.report.status,
        statements: statements.map((s) => ({ anchor: s.anchor, text: stripCitations(s.text) })),
      };
    });
    inputs.gaps.staleInputs = dailies
      .filter((d) => d.report.status === 'stale')
      .map((d) => d.report.id);
    if (fromKind === 'daily') {
      const have = new Set(dailies.map((d) => d.report.periodStart));
      const today = localDate(now, await workspaceTimeZone(tx));
      for (let d = report.periodStart; d < report.periodEndExcl && d < today; d = addDays(d, 1)) {
        const dow = new Date(`${d}T12:00:00Z`).getUTCDay();
        if (dow !== 0 && dow !== 6 && !have.has(d)) inputs.gaps.missingDays.push(d);
      }
    }
  }

  const guidance = await reportRepo.applicableGuidance(tx, {
    projectId,
    kind: report.kind,
    reportId: report.id,
  });
  inputs.guidance = guidance.map((g) => ({
    id: g.id,
    versionId: g.versionId,
    scope: g.scope,
    text: g.text,
  }));
  for (const g of guidance)
    inputRows.push({
      inputType: 'guidance_version',
      inputId: g.versionId,
      inputHash: g.contentHash,
    });
  const guidanceHash = contentHash({ guidance: guidance.map((g) => [g.versionId, g.contentHash]) });

  const counts = await reportRepo.statsFor(tx, {
    projectId,
    userId: ctx.actor.userId,
    from: report.periodStart,
    toExcl: report.periodEndExcl,
  });
  const statRows: Built['statRows'] = new Map();
  inputs.stats = Object.entries(counts).map(([metric, value]): StatView => {
    known.stats.add(metric);
    statRows.set(metric, {
      query: {
        metric,
        projectId,
        userId: ctx.actor.userId,
        from: report.periodStart,
        toExcl: report.periodEndExcl,
      },
      value,
    });
    return { metric, value, description: STAT_TEXT[metric] ?? metric };
  });

  const context = forAudience(await reportRepo.contextNotes(tx, projectId));
  if (context.length) inputs.context = await toViews(tx, ctx, context);

  const previous = report.currentVersionId
    ? await reportRepo.getVersion(tx, report.currentVersionId)
    : null;
  if (previous) inputs.previous = { versionId: previous.id, bodyMd: previous.bodyMd };

  inputRows.sort((a, b) =>
    `${a.inputType}${a.inputId}`.localeCompare(`${b.inputType}${b.inputId}`),
  );
  inputs.inputHash = contentHash({
    template: inputs.template.version,
    inputs: inputRows.map((i) => [i.inputType, i.inputId, i.inputHash]),
    // Revisions the report may cite: a re-routed or edited record changes these too.
    revisions: [...known.revisions.keys()].sort(),
  });
  return { inputs, known, inputRows, guidanceHash, statRows, previous };
}

async function mustGetReport(tx: Tx, id: string) {
  const r = await reportRepo.getReport(tx, id);
  if (!r) throw notFound('Report not found');
  return r;
}

/** `GET /reports/{r}/inputs` (and `get_report_inputs`). */
export async function getReportInputs(
  ctx: Ctx,
  reportId: string,
  now: Date = new Date(),
): Promise<ReportInputs> {
  const report = await asCaller(ctx, (tx) => mustGetReport(tx, reportId));
  await freshenBundles(ctx.db, report, now);
  return asCaller(
    ctx,
    async (tx) => (await buildInputs(tx, ctx, await mustGetReport(tx, reportId), now)).inputs,
  );
}

// ------------------------------------------------------------------------------------------
// Saving a version (api.md §4.3–4.4)
// ------------------------------------------------------------------------------------------

export const zSubmission = z.object({
  bodyMd: z.string().min(1).max(200_000),
  inputHash: z.string().min(1),
  changeSummary: z.string().trim().max(2000).optional(),
  generator: z
    .object({
      path: z.enum(['agent', 'direct']).default('agent'),
      client: z.string().trim().min(1).max(200).default('unknown'),
      model: z.string().trim().max(200).optional(),
    })
    .default({ path: 'agent', client: 'unknown' }),
});

const REF_TYPE = { r: 'record_revision', w: 'work_item', v: 'report_version', s: 'stat' } as const;

export async function saveReportVersion(
  ctx: Ctx,
  reportId: string,
  input: unknown,
  now: Date = new Date(),
): Promise<ReportVersionView> {
  const sub = parse(zSubmission, input);
  const report = await asCaller(ctx, (tx) => mustGetReport(tx, reportId));
  await freshenBundles(ctx.db, report, now);

  const versionId = await asCaller(ctx, async (tx) => {
    const r = await mustGetReport(tx, reportId);
    if (r.projectId) {
      const p = await projectRepo.findProject(tx, r.projectId);
      if (!atLeast(p?.role, 'contributor'))
        throw forbidden('You need at least contributor rights in this project');
    }
    const built = await buildInputs(tx, ctx, r, now);
    if (built.inputs.inputHash !== sub.inputHash) {
      throw new ServiceError(
        409,
        'stale_input',
        'The inputs changed since you read them: get the inputs again and rewrite',
        undefined,
        {
          inputHash: built.inputs.inputHash,
        },
      );
    }
    const v = validateReport(sub.bodyMd, built.known);
    if (!v.ok) {
      throw new ServiceError(
        422,
        'validation_failed',
        `The report has ${v.errors.length} problem(s); fix them and save again`,
        undefined,
        {
          validation: v.errors,
        },
      );
    }
    const prev = built.previous;
    if (prev && !sub.changeSummary) {
      throw new ServiceError(
        400,
        'bad_request',
        'changeSummary is required when a previous version exists',
        [{ path: 'changeSummary', message: 'Say what changed and why' }],
      );
    }
    const id = newId();
    const versions = await reportRepo.listVersions(tx, r.id);
    const cited = new Set(v.refs.filter((x) => x.citation.type === 's').map((x) => x.citation.id));
    await reportRepo.insertVersion(
      tx,
      {
        id,
        reportId: r.id,
        workspaceId: r.workspaceId,
        versionNo: (versions[0]?.versionNo ?? 0) + 1,
        bodyMd: sub.bodyMd,
        path: sub.generator.path,
        model: sub.generator.model ?? null,
        templateVersion: built.inputs.template.version,
        client: sub.generator.client,
        actorUserId: ctx.actor.userId,
        inputHash: built.inputs.inputHash,
        guidanceHash: built.guidanceHash,
        changeReason: !prev
          ? 'initial'
          : prev.inputHash !== built.inputs.inputHash
            ? 'factual'
            : 'editorial',
        changeSummary: sub.changeSummary ?? null,
        validation: { ok: true, statements: v.statements.length, refs: v.refs.length },
      },
      built.inputRows,
      v.refs.map((x) => ({
        anchor: x.anchor,
        refType: REF_TYPE[x.citation.type],
        refId: x.citation.anchor ? `${x.citation.id}#${x.citation.anchor}` : x.citation.id,
      })),
      [...cited].map((metric) => {
        const s = built.statRows.get(metric);
        return { id: newId(), metric, query: s?.query ?? {}, value: s?.value ?? null };
      }),
    );
    return id;
  });
  // Reports built on this one (weekly, monthly…) are now behind.
  await markStaleReports(ctx.db);
  return asCaller(ctx, async (tx) => {
    const v = await reportRepo.getVersion(tx, versionId);
    if (!v) throw new ServiceError(500, 'internal', 'Version not readable after save');
    return versionView(tx, await mustGetReport(tx, reportId), v);
  });
}

/** Staleness (schema.md §7), as a system job: after bundles change or versions are saved. */
export const markStaleReports = (db: HubDb) => withSystem(db, (tx) => reportRepo.markStale(tx));

// ------------------------------------------------------------------------------------------
// Reading
// ------------------------------------------------------------------------------------------

async function versionView(tx: Tx, r: ReportRow, v: ReportVersionRow): Promise<ReportVersionView> {
  const refs = await reportRepo.refsOf(tx, v.id);
  const titles = await reportRepo.revisionTitles(
    tx,
    refs.filter((x) => x.refType === 'record_revision').map((x) => x.refId),
  );
  const stats = new Map(
    (await reportRepo.statsOfVersion(tx, v.id)).map((s) => [s.metric, s.value]),
  );
  const citations: CitationView[] = refs.map((x) => {
    if (x.refType === 'record_revision') {
      const t = titles.get(x.refId);
      return {
        anchor: x.anchor,
        type: x.refType,
        id: x.refId,
        title: t?.title ?? null,
        url: t?.url ?? null,
      };
    }
    if (x.refType === 'stat') {
      return {
        anchor: x.anchor,
        type: x.refType,
        id: x.refId,
        title: `${x.refId} = ${JSON.stringify(stats.get(x.refId) ?? null)}`,
        url: null,
      };
    }
    return { anchor: x.anchor, type: x.refType, id: x.refId, title: null, url: null };
  });
  return {
    ...toRef(r, await titleOf(tx, r)),
    versionId: v.id,
    versionNo: v.versionNo,
    bodyMd: v.bodyMd,
    path: v.path,
    client: v.client,
    model: v.model,
    templateVersion: v.templateVersion,
    changeReason: v.changeReason,
    changeSummary: v.changeSummary,
    createdAt: v.createdAt.toISOString(),
    citations,
  };
}

export const zGetReport = z.object({
  projectId: z.string().min(1).optional(),
  kind: zKind.optional(),
  date: zIsoDate.optional(),
  audience: zAudience,
  versionId: z.string().min(1).optional(),
});

/** `get_report` / `GET /report-versions/{v}`: a version, or the current one of a report. */
export async function getReport(ctx: Ctx, input: unknown): Promise<ReportVersionView> {
  const q = parse(zGetReport, input);
  return asCaller(ctx, async (tx) => {
    if (q.versionId) {
      const v = await reportRepo.getVersion(tx, q.versionId);
      if (!v) throw notFound('Report version not found');
      return versionView(tx, await mustGetReport(tx, v.reportId), v);
    }
    if (!q.projectId || !q.kind || !q.date) {
      throw new ServiceError(400, 'bad_request', 'Give versionId, or projectId, kind and date');
    }
    const period = periodFor(q.kind, q.date, { weekStart: await weekStartOf(tx) });
    const r = await reportRepo.findReport(tx, {
      projectId: q.projectId,
      kind: q.kind,
      periodStart: period.start,
      audienceKey: audienceKeyOf(q.audience, ctx.actor.userId),
    });
    if (!r?.currentVersionId) throw notFound('No report for that period yet');
    const v = await reportRepo.getVersion(tx, r.currentVersionId);
    if (!v) throw notFound('No report for that period yet');
    return versionView(tx, r, v);
  });
}

export async function getReportById(ctx: Ctx, reportId: string): Promise<ReportRef> {
  return asCaller(ctx, async (tx) => {
    const r = await mustGetReport(tx, reportId);
    return toRef(r, await titleOf(tx, r));
  });
}

export async function listReportVersions(ctx: Ctx, reportId: string) {
  return asCaller(ctx, async (tx) => {
    await mustGetReport(tx, reportId);
    return (await reportRepo.listVersions(tx, reportId)).map((v) => ({
      versionId: v.id,
      versionNo: v.versionNo,
      path: v.path,
      client: v.client,
      model: v.model,
      changeReason: v.changeReason,
      changeSummary: v.changeSummary,
      createdAt: v.createdAt.toISOString(),
    }));
  });
}

export const zListReports = z.object({
  kind: zKind.optional(),
  from: zIsoDate,
  to: zIsoDate,
});

/** `GET /projects/{p}/reports?kind=&from=&to=`: reports whose audience includes the caller. */
export async function listReports(ctx: Ctx, projectId: string, query: unknown) {
  const q = parse(zListReports, query);
  return asCaller(ctx, async (tx) => {
    const weekStart = await weekStartOf(tx);
    const rows = await reportRepo.reportsInRange(tx, {
      projectId,
      ...(q.kind ? { kind: q.kind } : {}),
      from: q.from,
      toExcl: q.to,
    });
    return rows.map((x) => ({
      ...toRef(x.report, periodFor(x.report.kind, x.report.periodStart, { weekStart }).title),
      versionNo: x.versionNo,
      path: x.path,
      updatedAt: x.versionCreatedAt?.toISOString() ?? null,
    }));
  });
}

// ------------------------------------------------------------------------------------------
// Guidance (spec §4 Layer 4, api.md §3.6)
// ------------------------------------------------------------------------------------------

export const zGuidanceInput = z.object({
  scope: z.enum(['workspace', 'project', 'report_kind', 'report']),
  text: z.string().trim().min(1).max(4000),
  projectId: z.string().optional(),
  reportKind: zKind.optional(),
  reportId: z.string().optional(),
  visibility: z.enum(['project', 'private']).default('project'),
});

export async function addGuidance(ctx: Ctx, input: unknown) {
  const g = parse(zGuidanceInput, input);
  if (g.scope !== 'workspace' && g.scope !== 'report' && !g.projectId) {
    throw new ServiceError(400, 'bad_request', 'projectId is required for this scope');
  }
  if (g.scope === 'report_kind' && !g.reportKind) {
    throw new ServiceError(400, 'bad_request', 'reportKind is required for report_kind scope');
  }
  const id = newId();
  const versionId = newId();
  await asCaller(ctx, async (tx) => {
    let projectId = g.scope === 'workspace' ? null : (g.projectId ?? null);
    if (g.scope === 'report') {
      if (!g.reportId)
        throw new ServiceError(400, 'bad_request', 'reportId is required for report scope');
      projectId = (await mustGetReport(tx, g.reportId)).projectId;
    }
    try {
      await reportRepo.insertGuidance(
        tx,
        {
          id,
          workspaceId: ctx.actor.workspaceId,
          scope: g.scope,
          projectId,
          reportKind: g.scope === 'report_kind' ? (g.reportKind ?? null) : null,
          reportId: g.scope === 'report' ? (g.reportId ?? null) : null,
          authorUserId: ctx.actor.userId,
          visibility: g.visibility,
        },
        { id: versionId, text: g.text, contentHash: contentHash({ text: g.text }) },
      );
    } catch (e) {
      if (/row-level security/i.test(String((e as { cause?: unknown }).cause ?? e))) {
        throw forbidden(
          g.scope === 'workspace'
            ? 'Only the workspace owner can add workspace guidance'
            : g.scope === 'report'
              ? 'You need to be able to write that report'
              : 'You need manager rights in this project',
        );
      }
      throw e;
    }
  });
  return { guidanceId: id, versionId };
}

export async function listGuidance(ctx: Ctx, projectId?: string) {
  return asCaller(ctx, async (tx) =>
    (await reportRepo.listGuidance(tx, projectId)).map((g) => ({
      ...g,
      createdAt: g.createdAt.toISOString(),
    })),
  );
}

export async function archiveGuidance(ctx: Ctx, id: string): Promise<void> {
  const ok = await asCaller(ctx, (tx) => reportRepo.archiveGuidance(tx, id));
  if (!ok) throw notFound('Guidance not found');
  await markStaleReports(ctx.db);
}

export const isReportKind = (k: string): k is ReportKind =>
  (reportKinds as readonly string[]).includes(k);
export type { RecordView };
export { isIsoDate };

export const zStatsQuery = z.object({ projectId: z.string().min(1), from: zIsoDate, to: zIsoDate });

/** `GET /stats` / `get_stats`: the deterministic counts for a project and range (spec §5.8). */
export async function getStats(ctx: Ctx, input: unknown): Promise<StatView[]> {
  const q = parse(zStatsQuery, input);
  return asCaller(ctx, async (tx) => {
    if (!(await projectRepo.findProject(tx, q.projectId))) throw notFound('Project not found');
    const counts = await reportRepo.statsFor(tx, {
      projectId: q.projectId,
      userId: ctx.actor.userId,
      from: q.from,
      toExcl: q.to,
    });
    return Object.entries(counts).map(([metric, value]) => ({
      metric,
      value,
      description: STAT_TEXT[metric] ?? metric,
    }));
  });
}
