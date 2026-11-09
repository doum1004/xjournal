import { addDays, type DueReport, localDate, type StatusView } from '@xjournal/core';
import { projectRepo, recordRepo, reportRepo } from '@xjournal/db';
import { periodFor } from '@xjournal/reports';
import { listConnectors } from './connectors';
import { asCaller, type Ctx } from './context';
import { notFound } from './errors';
import { atLeast } from './projects';

// `GET /status` / `get_status` (api.md §3.4): what needs writing, oldest first (spec §5.1).
// A morning run walks `due`: every weekday of the catch-up window that has evidence but no
// current daily report, stale reports, and the previous week's and month's reviews.

export interface StatusOptions {
  projectId?: string;
  now?: Date;
  /** Catch-up window in days (default 14). */
  days?: number;
}

const isWeekday = (d: string) => {
  const dow = new Date(`${d}T12:00:00Z`).getUTCDay();
  return dow !== 0 && dow !== 6;
};

export async function getStatus(ctx: Ctx, opts: StatusOptions = {}): Promise<StatusView> {
  const now = opts.now ?? new Date();
  const window = opts.days ?? 14;
  const meKey = `me:${ctx.actor.userId}`;
  const base = await asCaller(ctx, async (tx) => {
    const ws = await projectRepo.getWorkspaceSettings(tx);
    const all = await projectRepo.listProjects(tx);
    const projects = opts.projectId ? all.filter((p) => p.id === opts.projectId) : all;
    if (opts.projectId && !projects.length) throw notFound('Project not found');
    const due: DueReport[] = [];
    const missingDays: StatusView['missingDays'] = [];
    const staleReports: StatusView['staleReports'] = [];

    for (const p of projects) {
      if (!atLeast(p.role, 'contributor')) continue;
      const tz = p.timeZone ?? ws?.timeZone ?? 'UTC';
      const today = localDate(now, tz);
      const from = addDays(today, -window);
      const counts = await recordRepo.dayCounts(tx, {
        projectId: p.id,
        userId: ctx.actor.userId,
        from,
        to: today,
      });
      const written = new Set(
        (
          await reportRepo.dailyReportDates(tx, {
            projectId: p.id,
            audienceKey: meKey,
            from,
            toExcl: today,
          })
        ).map((d) => d.date),
      );
      for (const c of counts) {
        if (c.recordCount > 0 && isWeekday(c.date) && !written.has(c.date)) {
          missingDays.push({ projectId: p.id, date: c.date });
          due.push({ kind: 'daily', date: c.date, projectId: p.id, reason: 'missing' });
        }
      }

      // Stale reports from the last ~two months.
      const recent = await reportRepo.reportsInRange(tx, {
        projectId: p.id,
        from: addDays(today, -62),
        toExcl: addDays(today, 1),
        audienceKey: meKey,
      });
      for (const r of recent) {
        if (r.report.status === 'stale' && r.report.currentVersionId) {
          staleReports.push({
            reportId: r.report.id,
            kind: r.report.kind,
            date: r.report.periodStart,
            projectId: p.id,
          });
          due.push({
            kind: r.report.kind,
            date: r.report.periodStart,
            projectId: p.id,
            reason: 'stale',
          });
        }
      }

      // The last complete week and month, once they have daily reports.
      const have = new Set(
        recent
          .filter((r) => r.report.currentVersionId)
          .map((r) => `${r.report.kind}:${r.report.periodStart}`),
      );
      const weekStart = ws?.weekStart ?? 1;
      const lastWeek = periodFor('weekly', addDays(today, -7), { weekStart });
      const lastMonth = periodFor('monthly', addDays(periodFor('monthly', today).start, -1));
      for (const [kind, period] of [
        ['weekly', lastWeek],
        ['monthly', lastMonth],
      ] as const) {
        if (have.has(`${kind}:${period.start}`)) continue;
        const dailies = await reportRepo.dailyReportDates(tx, {
          projectId: p.id,
          audienceKey: meKey,
          from: period.start,
          toExcl: period.endExcl,
        });
        if (dailies.length)
          due.push({ kind, date: period.start, projectId: p.id, reason: 'missing' });
      }
    }

    const order = {
      daily: 0,
      weekly: 1,
      biweekly: 2,
      monthly: 3,
      quarterly: 4,
      yearly: 5,
    } as const;
    due.sort((a, b) => order[a.kind] - order[b.kind] || a.date.localeCompare(b.date));
    return {
      projects: all.map((p) => ({
        id: p.id,
        slug: p.slug,
        name: p.name,
        role: p.role ?? 'viewer',
      })),
      due,
      missingDays,
      staleReports,
      inboxCount: await reportRepo.inboxCount(tx, ctx.actor.userId),
    };
  });
  const connectors = (await listConnectors(ctx)).map((c) => {
    const last = c.streams
      .map((s) => s.lastSuccessAt)
      .filter((x): x is string => !!x)
      .sort()[0];
    return {
      id: c.id,
      source: c.source,
      status: c.status,
      lastSuccessAt: last ?? null,
      error: c.streams.find((s) => s.lastError)?.lastError ?? null,
    };
  });
  return { ...base, connectors };
}
