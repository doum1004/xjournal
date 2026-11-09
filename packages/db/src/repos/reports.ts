import type { ReportKind } from '@xjournal/core';
import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, lt, sql } from 'drizzle-orm';
import type { Tx } from '../actor';
import {
  evidenceRefs,
  exportsTable,
  guidance,
  guidanceVersions,
  projectMembers,
  records,
  reportAudience,
  reportInputs,
  reportStats,
  reports,
  reportVersions,
  users,
} from '../schema';

// Reports and guidance (schema.md §7). Reads and writes run under RLS (`withActor`), except
// `markStale`, which a system job runs.

export type ReportRow = typeof reports.$inferSelect;
export type ReportVersionRow = typeof reportVersions.$inferSelect;

export async function findReport(
  tx: Tx,
  k: { projectId: string; kind: ReportKind; periodStart: string; audienceKey: string },
): Promise<ReportRow | null> {
  const rows = await tx
    .select()
    .from(reports)
    .where(
      and(
        eq(reports.projectId, k.projectId),
        eq(reports.kind, k.kind),
        eq(reports.periodStart, k.periodStart),
        eq(reports.audienceKey, k.audienceKey),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

export async function getReport(tx: Tx, id: string): Promise<ReportRow | null> {
  const rows = await tx.select().from(reports).where(eq(reports.id, id)).limit(1);
  return rows[0] ?? null;
}

export async function insertReport(tx: Tx, row: typeof reports.$inferInsert, audience: string[]) {
  await tx.insert(reports).values(row);
  await tx
    .insert(reportAudience)
    .values(audience.map((userId) => ({ reportId: row.id, userId, workspaceId: row.workspaceId })));
}

export async function audienceOf(tx: Tx, reportId: string) {
  return tx
    .select({ id: users.id, name: users.displayName })
    .from(reportAudience)
    .innerJoin(users, eq(users.id, reportAudience.userId))
    .where(eq(reportAudience.reportId, reportId))
    .orderBy(asc(users.displayName));
}

/** Current members of a project (for a project-wide audience). */
export async function projectMemberIds(tx: Tx, projectId: string): Promise<string[]> {
  const rows = await tx
    .select({ id: projectMembers.userId })
    .from(projectMembers)
    .where(and(eq(projectMembers.projectId, projectId), isNull(projectMembers.leftAt)));
  return rows.map((r) => r.id);
}

export async function getVersion(tx: Tx, id: string): Promise<ReportVersionRow | null> {
  const rows = await tx.select().from(reportVersions).where(eq(reportVersions.id, id)).limit(1);
  return rows[0] ?? null;
}

export async function listVersions(tx: Tx, reportId: string): Promise<ReportVersionRow[]> {
  return tx
    .select()
    .from(reportVersions)
    .where(eq(reportVersions.reportId, reportId))
    .orderBy(desc(reportVersions.versionNo));
}

export async function insertVersion(
  tx: Tx,
  v: typeof reportVersions.$inferInsert,
  inputs: { inputType: string; inputId: string; inputHash: string }[],
  refs: {
    anchor: string;
    refType: 'record_revision' | 'work_item' | 'report_version' | 'stat';
    refId: string;
  }[],
  stats: { id: string; metric: string; query: unknown; value: unknown }[],
): Promise<void> {
  await tx.insert(reportVersions).values(v);
  const base = { reportVersionId: v.id, workspaceId: v.workspaceId };
  if (inputs.length) await tx.insert(reportInputs).values(inputs.map((i) => ({ ...base, ...i })));
  const uniqRefs = [
    ...new Map(refs.map((r) => [`${r.anchor}|${r.refType}|${r.refId}`, r])).values(),
  ];
  for (let i = 0; i < uniqRefs.length; i += 500) {
    await tx
      .insert(evidenceRefs)
      .values(uniqRefs.slice(i, i + 500).map((r) => ({ ...base, ...r })));
  }
  if (stats.length) await tx.insert(reportStats).values(stats.map((s) => ({ ...base, ...s })));
  await tx
    .update(reports)
    .set({ currentVersionId: v.id, status: 'current', staleSince: null })
    .where(eq(reports.id, v.reportId));
}

export async function inputsOf(tx: Tx, versionId: string) {
  return tx.select().from(reportInputs).where(eq(reportInputs.reportVersionId, versionId));
}

export async function refsOf(tx: Tx, versionId: string) {
  return tx.select().from(evidenceRefs).where(eq(evidenceRefs.reportVersionId, versionId));
}

/** Reports of a project in a date range, with their current version (visible ones only). */
export async function reportsInRange(
  tx: Tx,
  o: { projectId: string; kind?: ReportKind; from: string; toExcl: string; audienceKey?: string },
) {
  return tx
    .select({
      report: reports,
      versionNo: reportVersions.versionNo,
      versionCreatedAt: reportVersions.createdAt,
      bodyMd: reportVersions.bodyMd,
      path: reportVersions.path,
    })
    .from(reports)
    .leftJoin(reportVersions, eq(reportVersions.id, reports.currentVersionId))
    .where(
      and(
        eq(reports.projectId, o.projectId),
        o.kind ? eq(reports.kind, o.kind) : undefined,
        gte(reports.periodStart, o.from),
        lt(reports.periodStart, o.toExcl),
        o.audienceKey ? eq(reports.audienceKey, o.audienceKey) : undefined,
      ),
    )
    .orderBy(asc(reports.periodStart), asc(reports.kind));
}

// ------------------------------------------------------------------------------------------
// Guidance
// ------------------------------------------------------------------------------------------

export async function insertGuidance(
  tx: Tx,
  g: typeof guidance.$inferInsert,
  v: { id: string; text: string; contentHash: string },
): Promise<void> {
  await tx.insert(guidance).values(g);
  await tx.insert(guidanceVersions).values({
    id: v.id,
    guidanceId: g.id,
    workspaceId: g.workspaceId,
    versionNo: 1,
    text: v.text,
    contentHash: v.contentHash,
    createdBy: g.authorUserId,
  });
  await tx.update(guidance).set({ currentVersionId: v.id }).where(eq(guidance.id, g.id));
}

/**
 * Guidance that applies to a report, most specific first (spec §4 Layer 4): the report, its
 * kind in the project, the project, the workspace. Visible ones only.
 */
export async function applicableGuidance(
  tx: Tx,
  o: { projectId: string | null; kind: ReportKind; reportId: string },
) {
  const rows = await tx
    .select({
      id: guidance.id,
      scope: guidance.scope,
      projectId: guidance.projectId,
      reportKind: guidance.reportKind,
      reportId: guidance.reportId,
      versionId: guidanceVersions.id,
      text: guidanceVersions.text,
      contentHash: guidanceVersions.contentHash,
    })
    .from(guidance)
    .innerJoin(guidanceVersions, eq(guidanceVersions.id, guidance.currentVersionId))
    .where(isNull(guidance.archivedAt));
  const rank = { report: 0, report_kind: 1, project: 2, workspace: 3 } as const;
  return rows
    .filter(
      (g) =>
        (g.scope === 'workspace' && g.projectId == null) ||
        (g.scope === 'project' && g.projectId === o.projectId) ||
        (g.scope === 'report_kind' && g.projectId === o.projectId && g.reportKind === o.kind) ||
        (g.scope === 'report' && g.reportId === o.reportId),
    )
    .sort((a, b) => rank[a.scope] - rank[b.scope] || a.id.localeCompare(b.id));
}

export async function listGuidance(tx: Tx, projectId?: string) {
  return tx
    .select({
      id: guidance.id,
      scope: guidance.scope,
      projectId: guidance.projectId,
      reportKind: guidance.reportKind,
      reportId: guidance.reportId,
      visibility: guidance.visibility,
      authorUserId: guidance.authorUserId,
      versionId: guidanceVersions.id,
      versionNo: guidanceVersions.versionNo,
      text: guidanceVersions.text,
      createdAt: guidanceVersions.createdAt,
    })
    .from(guidance)
    .innerJoin(guidanceVersions, eq(guidanceVersions.id, guidance.currentVersionId))
    .where(
      and(
        isNull(guidance.archivedAt),
        projectId
          ? sql`(${guidance.projectId} = ${projectId} or ${guidance.projectId} is null)`
          : undefined,
      ),
    )
    .orderBy(asc(guidance.scope), asc(guidanceVersions.createdAt));
}

export async function archiveGuidance(tx: Tx, id: string): Promise<boolean> {
  const rows = await tx
    .update(guidance)
    .set({ archivedAt: new Date() })
    .where(eq(guidance.id, id))
    .returning({ id: guidance.id });
  return rows.length > 0;
}

// ------------------------------------------------------------------------------------------
// Stats (spec §5.8): deterministic numbers over Layer 1
// ------------------------------------------------------------------------------------------

/** Counts of the caller's own records in a project and period, by metric. */
export async function statsFor(
  tx: Tx,
  o: { projectId: string; userId: string; from: string; toExcl: string },
): Promise<Record<string, number>> {
  const rows = await tx.execute<{ metric: string; n: number }>(sql`
    with r as (
      select r.kind, r.external_id, r.applicable_date from records r
      where r.project_id = ${o.projectId} and r.owner_user_id = ${o.userId} and r.is_mine
        and r.hidden_at is null
        and r.applicable_date >= ${o.from} and r.applicable_date < ${o.toExcl})
    select 'prs_opened' as metric, count(*)::int as n from r where kind = 'pull_request' and external_id like '%/opened'
    union all select 'prs_merged', count(*)::int from r where kind = 'pull_request' and external_id like '%/merged'
    union all select 'reviews', count(*)::int from r where kind = 'review'
    union all select 'commits', count(*)::int from r where kind = 'commit'
    union all select 'code_comments', count(*)::int from r where kind = 'code_comment'
    union all select 'issues_created', count(*)::int from r where kind = 'issue_created'
    union all select 'issue_changes', count(*)::int from r where kind = 'issue_change'
    union all select 'issue_comments', count(*)::int from r where kind = 'issue_comment'
    union all select 'pages_edited', count(*)::int from r where kind = 'page_edit'
    union all select 'page_comments', count(*)::int from r where kind = 'page_comment'
    union all select 'meetings', count(*)::int from r where kind in ('meeting', 'meeting_summary')
    union all select 'notes', count(*)::int from r where kind = 'note'
    union all select 'active_days', count(distinct applicable_date)::int from r`);
  return Object.fromEntries(rows.rows.map((r) => [r.metric, Number(r.n)]));
}

/** The project's standing context notes (any date). */
export async function contextNotes(tx: Tx, projectId: string) {
  return tx
    .select()
    .from(records)
    .where(
      and(
        eq(records.projectId, projectId),
        eq(records.kind, 'note'),
        eq(records.noteKind, 'context'),
        isNull(records.hiddenAt),
      ),
    )
    .orderBy(desc(records.applicableDate))
    .limit(50);
}

// ------------------------------------------------------------------------------------------
// Staleness (schema.md §7), as a system job
// ------------------------------------------------------------------------------------------

/**
 * Mark reports stale whose recorded inputs no longer match: a bundle's hash changed, an input
 * report has a newer current version, a guidance item has a newer version, or (for period
 * reports) the set of current daily reports in the period changed. Repeats until nothing
 * changes, so staleness climbs daily → weekly/monthly → quarterly/yearly. Returns the count.
 */
export async function markStale(tx: Tx): Promise<number> {
  let total = 0;
  for (let round = 0; round < 6; round++) {
    const r = await tx.execute(sql`
      update reports rp set status = 'stale', stale_since = coalesce(rp.stale_since, now())
      where rp.status = 'current' and rp.current_version_id is not null and (
        exists (select 1 from report_inputs i join daily_bundles b on b.id = i.input_id
                where i.report_version_id = rp.current_version_id and i.input_type = 'bundle'
                  and b.content_hash <> i.input_hash)
        or exists (select 1 from report_inputs i
                   join report_versions v on v.id = i.input_id
                   join reports src on src.id = v.report_id
                   where i.report_version_id = rp.current_version_id and i.input_type = 'report_version'
                     and (src.current_version_id is distinct from v.id or src.status = 'stale'))
        or exists (select 1 from report_inputs i
                   join guidance_versions gv on gv.id = i.input_id
                   join guidance g on g.id = gv.guidance_id
                   where i.report_version_id = rp.current_version_id and i.input_type = 'guidance_version'
                     and (g.current_version_id is distinct from gv.id or g.archived_at is not null))
        or (rp.kind in ('weekly', 'biweekly', 'monthly', 'quarterly', 'yearly')
            and exists (select 1 from report_inputs i where i.report_version_id = rp.current_version_id
                        and i.input_type <> 'guidance_version')
            and (select count(*) from reports d
                 where d.project_id = rp.project_id and d.audience_key = rp.audience_key
                   and d.kind = (case when rp.kind in ('quarterly', 'yearly') then 'monthly' else 'daily' end)::report_kind
                   and d.period_start >= rp.period_start and d.period_start < rp.period_end_excl
                   and d.current_version_id is not null)
              <> (select count(*) from report_inputs i where i.report_version_id = rp.current_version_id
                  and i.input_type = 'report_version')))`);
    const n = r.rowCount ?? r.affectedRows ?? 0;
    total += n;
    if (!n) break;
  }
  return total;
}

/** Current daily reports per date in a range (system: which days still need one). */
export async function dailyReportDates(
  tx: Tx,
  o: { projectId: string; audienceKey: string; from: string; toExcl: string },
) {
  return tx
    .select({ date: reports.periodStart, status: reports.status, reportId: reports.id })
    .from(reports)
    .where(
      and(
        eq(reports.projectId, o.projectId),
        eq(reports.kind, 'daily'),
        eq(reports.audienceKey, o.audienceKey),
        gte(reports.periodStart, o.from),
        lt(reports.periodStart, o.toExcl),
        isNotNull(reports.currentVersionId),
      ),
    );
}

export async function reportsById(tx: Tx, ids: string[]) {
  if (!ids.length) return [];
  return tx.select().from(reports).where(inArray(reports.id, ids));
}

/** A project's non-hidden records in a date range (under RLS: what the caller sees). */
export async function recordsInRange(tx: Tx, projectId: string, from: string, toExcl: string) {
  return tx
    .select()
    .from(records)
    .where(
      and(
        eq(records.projectId, projectId),
        gte(records.applicableDate, from),
        lt(records.applicableDate, toExcl),
        isNull(records.hiddenAt),
      ),
    )
    .orderBy(asc(records.applicableDate), asc(records.eventTime));
}

/** Titles and links of cited record revisions (under RLS). */
export async function revisionTitles(tx: Tx, revisionIds: string[]) {
  if (!revisionIds.length) return new Map<string, { title: string; url: string | null }>();
  const rows = await tx.execute<{ id: string; title: string; url: string | null }>(sql`
    select rv.id, rv.title, r.url from record_revisions rv join records r on r.id = rv.record_id
    where rv.id in ${revisionIds}`);
  return new Map(rows.rows.map((r) => [r.id, { title: r.title, url: r.url }]));
}

export async function statsOfVersion(tx: Tx, versionId: string) {
  return tx.select().from(reportStats).where(eq(reportStats.reportVersionId, versionId));
}

export async function inboxCount(tx: Tx, userId: string): Promise<number> {
  const r = await tx.execute<{ n: number }>(sql`
    select count(*)::int as n from records
    where owner_user_id = ${userId} and hidden_at is null
      and (project_id is null or routing_status = 'needs_review')`);
  return Number(r.rows[0]?.n ?? 0);
}

/** The caller's imported daily logs in a project (prototype migration, schema.md §11). */
export async function importedLogs(tx: Tx, projectId: string, userId: string) {
  return tx.execute<{
    date: string;
    source: string;
    revision_id: string;
    text: string | null;
    summary: string | null;
    title: string;
  }>(sql`
    select r.applicable_date::text as date, r.source, r.current_revision_id as revision_id,
           rv.payload->>'text' as text, r.summary, r.title
    from records r join record_revisions rv on rv.id = r.current_revision_id
    where r.project_id = ${projectId} and r.owner_user_id = ${userId}
      and r.kind = 'imported_log' and r.hidden_at is null
    order by r.applicable_date, (r.source = 'worklog') desc`);
}

export async function setReportStale(tx: Tx, reportId: string): Promise<void> {
  await tx
    .update(reports)
    .set({ status: 'stale', staleSince: new Date() })
    .where(eq(reports.id, reportId));
}

/** The last time the caller published `target` to `destination` (the edit-conflict guard). */
export async function lastExport(tx: Tx, userId: string, destination: string, target: string) {
  const rows = await tx
    .select()
    .from(exportsTable)
    .where(
      and(
        eq(exportsTable.createdBy, userId),
        eq(exportsTable.destination, destination),
        eq(exportsTable.target, target),
      ),
    )
    .orderBy(desc(exportsTable.createdAt))
    .limit(1);
  return rows[0] ?? null;
}

export async function insertExport(tx: Tx, row: typeof exportsTable.$inferInsert): Promise<void> {
  await tx.insert(exportsTable).values(row);
}
