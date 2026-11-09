import { type DaySummary, type DayView, isIsoDate, zDayRange } from '@xjournal/core';
import { projectRepo, recordRepo, type Tx } from '@xjournal/db';
import { asCaller, type Ctx } from './context';
import { notFound, parse, ServiceError } from './errors';
import { toViews } from './records';

// Days (api.md §3.4). In M1 a day is its records; bundles, coverage and the daily report
// fill in the remaining fields in M2–M3.

async function mustSeeProject(tx: Tx, projectId: string) {
  const p = await projectRepo.findProject(tx, projectId);
  if (!p) throw notFound('Project not found');
  return p;
}

/** `GET /projects/{p}/days?from=&to=`: only days with at least one visible record. */
export async function listDays(ctx: Ctx, projectId: string, query: unknown): Promise<DaySummary[]> {
  const range = parse(zDayRange, query);
  return asCaller(ctx, async (tx) => {
    await mustSeeProject(tx, projectId);
    const counts = await recordRepo.dayCounts(tx, {
      projectId,
      userId: ctx.actor.userId,
      ...range,
    });
    return counts.map((c) => ({
      ...c,
      bundleHash: null,
      dirty: false,
      daily: null,
      coverage: {},
    }));
  });
}

/** `GET /projects/{p}/days/{date}`. */
export async function getDay(ctx: Ctx, projectId: string, date: string): Promise<DayView> {
  if (!isIsoDate(date)) throw new ServiceError(400, 'bad_request', 'Expected a date as YYYY-MM-DD');
  return asCaller(ctx, async (tx) => {
    await mustSeeProject(tx, projectId);
    const rows = await recordRepo.recordsOnDay(tx, projectId, date);
    return {
      date,
      projectId,
      bundle: null,
      workItems: [],
      unlinked: await toViews(tx, ctx, rows),
      daily: null,
      coverage: {},
    };
  });
}
