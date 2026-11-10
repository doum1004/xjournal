import { addDays, type DaySummary, type DayView, isIsoDate, zDayRange } from '@xjournal/core';
import { bundleRepo, projectRepo, recordRepo, reportRepo, type Tx } from '@xjournal/db';
import { asCaller, type Ctx } from './context';
import { notFound, parse, ServiceError } from './errors';
import { toViews } from './records';
import { groupByWorkItem } from './workitems';

// Days (api.md §3.4): a day's records, its bundle (hash, staleness, coverage) and, from M3,
// its daily report.

const dailyOf = (
  r: ({ reportId: string; status: string } & { versionId?: string | null }) | undefined,
) => (r ? { reportId: r.reportId, status: r.status, versionId: r.versionId ?? null } : null);

async function mustSeeProject(tx: Tx, projectId: string) {
  const p = await projectRepo.findProject(tx, projectId);
  if (!p) throw notFound('Project not found');
  return p;
}

/** `GET /projects/{p}/days?from=&to=`: days with at least one visible record. */
export async function listDays(ctx: Ctx, projectId: string, query: unknown): Promise<DaySummary[]> {
  const range = parse(zDayRange, query);
  return asCaller(ctx, async (tx) => {
    await mustSeeProject(tx, projectId);
    const counts = await recordRepo.dayCounts(tx, {
      projectId,
      userId: ctx.actor.userId,
      ...range,
    });
    const reports = new Map(
      (
        await reportRepo.dailyReportDates(tx, {
          projectId,
          audienceKey: `me:${ctx.actor.userId}`,
          from: range.from,
          toExcl: range.to,
        })
      ).map((r) => [r.date, r]),
    );
    const bundles = new Map(
      (await bundleRepo.bundlesInRange(tx, projectId, range.from, addDays(range.to, -1))).map(
        (b) => [b.date, b],
      ),
    );
    return counts.map((c) => {
      const b = bundles.get(c.date);
      return {
        ...c,
        bundleHash: b?.contentHash ?? null,
        dirty: !b || b.dirtySince != null,
        daily: dailyOf(reports.get(c.date)),
        coverage: (b?.coverage ?? {}) as DaySummary['coverage'],
      };
    });
  });
}

/** `GET /projects/{p}/days/{date}`. */
export async function getDay(ctx: Ctx, projectId: string, date: string): Promise<DayView> {
  if (!isIsoDate(date)) throw new ServiceError(400, 'bad_request', 'Expected a date as YYYY-MM-DD');
  return asCaller(ctx, async (tx) => {
    await mustSeeProject(tx, projectId);
    const rows = await recordRepo.recordsOnDay(tx, projectId, date);
    const b = await bundleRepo.getBundle(tx, projectId, date);
    const items = b ? await bundleRepo.bundleItemCount(tx, [b.id]) : new Map<string, number>();
    const grouped = await groupByWorkItem(tx, await toViews(tx, ctx, rows));
    return {
      date,
      projectId,
      bundle: b
        ? {
            id: b.id,
            hash: b.contentHash,
            builtAt: b.builtAt.toISOString(),
            dirty: b.dirtySince != null,
            itemCount: items.get(b.id) ?? 0,
          }
        : null,
      ...grouped,
      daily: dailyOf(
        (
          await reportRepo.dailyReportDates(tx, {
            projectId,
            audienceKey: `me:${ctx.actor.userId}`,
            from: date,
            toExcl: addDays(date, 1),
          })
        )[0],
      ),
      coverage: (b?.coverage ?? {}) as DayView['coverage'],
    };
  });
}
