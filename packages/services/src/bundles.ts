import {
  addDays,
  type ConnectorCoverage,
  type Coverage,
  contentHash,
  isIsoDate,
  localDate,
  startOfDay,
} from '@xjournal/core';
import { bundleRepo, type HubDb, projectRepo, withSystem } from '@xjournal/db';
import { asCaller, type Ctx } from './context';
import { forbidden, notFound, ServiceError } from './errors';
import { atLeast } from './projects';

// Daily bundles (spec §4 Layer 2, schema.md §6): for each project and applicable date, the
// current revisions of every record on that day plus each connector's coverage of it, under
// one content hash. Reports (M3) record the hash they were built from; a changed hash makes
// them stale. Bundles are system-built, so they cover records whatever their visibility.

type CoverageInput = Awaited<ReturnType<typeof bundleRepo.projectCoverageInputs>>[number];

/**
 * One connector's coverage of the day `[dayStart, dayEnd)`. Kept free of sync timestamps,
 * so a day's coverage (and hash) stops changing once the day is complete.
 */
export function coverageOf(
  streams: CoverageInput[],
  dayStart: Date,
  dayEnd: Date,
): ConnectorCoverage {
  const source = streams[0]?.source ?? '';
  const synced = streams.filter((s) => s.stream != null);
  const floor = synced
    .map((s) => s.historyFloor)
    .filter((d): d is Date => d != null && d > dayStart)
    .sort((a, b) => b.getTime() - a.getTime())[0];
  if (floor) return { source, status: 'truncated', truncatedBefore: floor.toISOString() };
  const complete =
    synced.length > 0 && synced.every((s) => s.lastSuccessAt != null && s.lastSuccessAt >= dayEnd);
  if (complete) return { source, status: 'complete' };
  if (synced.some((s) => s.lastError)) return { source, status: 'error' };
  return { source, status: 'pending' };
}

export function coverageFor(inputs: CoverageInput[], date: string, timeZone: string): Coverage {
  const dayStart = startOfDay(date, timeZone);
  const dayEnd = startOfDay(addDays(date, 1), timeZone);
  const byAccount = new Map<string, CoverageInput[]>();
  for (const i of inputs) {
    byAccount.set(i.connectorAccountId, [...(byAccount.get(i.connectorAccountId) ?? []), i]);
  }
  const out: Coverage = {};
  for (const [id, streams] of [...byAccount.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    out[id] = coverageOf(streams, dayStart, dayEnd);
  }
  return out;
}

export const bundleHash = (revisionIds: string[], coverage: Coverage) =>
  contentHash({ revisions: [...revisionIds].sort(), coverage });

export interface BuildResult {
  projectId: string;
  date: string;
  hash: string;
  changed: boolean;
  items: number;
}

/** Build one project's bundle for one date (system). */
export async function buildBundle(
  db: HubDb,
  project: { id: string; workspaceId: string; timeZone: string },
  date: string,
  now: Date = new Date(),
): Promise<BuildResult> {
  return withSystem(db, async (tx) => {
    const inputs = await bundleRepo.dayInputs(tx, project.id, date);
    const coverage = coverageFor(
      await bundleRepo.projectCoverageInputs(tx, project.id),
      date,
      project.timeZone,
    );
    const revisionIds = inputs.map((i) => i.revisionId);
    const hash = bundleHash(revisionIds, coverage);
    const saved = await bundleRepo.saveBundle(tx, {
      workspaceId: project.workspaceId,
      projectId: project.id,
      date,
      contentHash: hash,
      coverage,
      revisionIds,
      builtAt: now,
    });
    return { projectId: project.id, date, hash, changed: saved.changed, items: revisionIds.length };
  });
}

export interface RebuildOptions {
  now?: Date;
  /** The catch-up window: rebuild every day of the last N days (default 14, spec §5.1). */
  days?: number;
  projectIds?: string[];
}

export interface RebuildSummary {
  projects: number;
  built: number;
  changed: number;
  /** Days whose hash changed, per project. */
  changedDays: { projectId: string; date: string }[];
}

/**
 * The bundle half of the morning run: for each project, every day in the catch-up window
 * (their coverage moves as syncs complete), plus every dirty or missing day before it.
 */
export async function rebuildBundles(
  db: HubDb,
  opts: RebuildOptions = {},
): Promise<RebuildSummary> {
  const now = opts.now ?? new Date();
  const window = opts.days ?? 14;
  const all = await withSystem(db, (tx) => bundleRepo.allProjects(tx));
  const projects = opts.projectIds ? all.filter((p) => opts.projectIds?.includes(p.id)) : all;
  const summary: RebuildSummary = {
    projects: projects.length,
    built: 0,
    changed: 0,
    changedDays: [],
  };

  for (const p of projects) {
    const today = localDate(now, p.timeZone);
    const dates = new Set<string>();
    for (let i = 0; i < window; i++) dates.add(addDays(today, -i));
    for (const d of await withSystem(db, (tx) => bundleRepo.staleDays(tx, p.id))) dates.add(d);
    // Skip window days with nothing: no records and no bundle to keep current.
    const existing = new Set(
      (
        await withSystem(db, (tx) =>
          bundleRepo.bundlesInRange(tx, p.id, addDays(today, 1 - window), today),
        )
      ).map((b) => b.date),
    );
    for (const date of [...dates].sort()) {
      if (date > today) continue;
      const inWindow = date > addDays(today, -window);
      if (inWindow && !existing.has(date)) {
        const n = await withSystem(db, (tx) => bundleRepo.dayInputs(tx, p.id, date));
        if (!n.length) continue;
      }
      const r = await buildBundle(db, p, date, now);
      summary.built++;
      if (r.changed) {
        summary.changed++;
        summary.changedDays.push({ projectId: p.id, date });
      }
    }
  }
  return summary;
}

/** `POST /projects/{p}/days/{date}/rebuild` (api.md §3.4): contributor and up. */
export async function rebuildDay(ctx: Ctx, projectId: string, date: string): Promise<BuildResult> {
  if (!isIsoDate(date)) throw new ServiceError(400, 'bad_request', 'Expected a date as YYYY-MM-DD');
  const project = await asCaller(ctx, (tx) => projectRepo.findProject(tx, projectId));
  if (!project) throw notFound('Project not found');
  if (!atLeast(project.role, 'contributor')) {
    throw forbidden('You need at least contributor rights in this project');
  }
  const [p] = (await withSystem(ctx.db, (tx) => bundleRepo.allProjects(tx))).filter(
    (x) => x.id === projectId,
  );
  if (!p) throw notFound('Project not found');
  return buildBundle(ctx.db, p, date);
}
