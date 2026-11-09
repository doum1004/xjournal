import { addDays, type DaySummary, type DayView, isIsoDate, zDayRange } from '@xjournal/core';
import { bundleRepo, projectRepo, recordRepo, type Tx } from '@xjournal/db';
import { asCaller, type Ctx } from './context';
import { notFound, parse, ServiceError } from './errors';
import { toViews } from './records';

// Days (api.md §3.4): a day's records, its bundle (hash, staleness, coverage) and, from M3,
// its daily report.

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
        daily: null,
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
      workItems: [],
      unlinked: await toViews(tx, ctx, rows),
      daily: null,
      coverage: (b?.coverage ?? {}) as DayView['coverage'],
    };
  });
}
