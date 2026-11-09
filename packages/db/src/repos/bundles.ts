import { newId } from '@xjournal/core';
import { and, asc, eq, gte, inArray, isNotNull, isNull, lte, sql } from 'drizzle-orm';
import type { Tx } from '../actor';
import {
  bundleItems,
  connectorAccounts,
  dailyBundles,
  projectSources,
  projects,
  records,
  syncStates,
  workspaces,
} from '../schema';

// Daily bundles (schema.md §6). Writes run in a system transaction (`withSystem`); reads in
// `withActor` see only what the bundle policies allow.

export type BundleRow = typeof dailyBundles.$inferSelect;

/** Every active project with its effective time zone (system). */
export async function allProjects(tx: Tx) {
  return tx
    .select({
      id: projects.id,
      workspaceId: projects.workspaceId,
      slug: projects.slug,
      timeZone: sql<string>`coalesce(${projects.timeZone}, ${workspaces.timeZone})`,
    })
    .from(projects)
    .innerJoin(workspaces, eq(workspaces.id, projects.workspaceId))
    .where(isNull(projects.archivedAt))
    .orderBy(asc(projects.createdAt));
}

/** The current revisions that make up a day: every non-hidden record, whatever its visibility. */
export async function dayInputs(tx: Tx, projectId: string, date: string) {
  return tx
    .select({
      recordId: records.id,
      revisionId: records.currentRevisionId,
      source: records.source,
      connectorAccountId: records.connectorAccountId,
    })
    .from(records)
    .where(
      and(
        eq(records.projectId, projectId),
        eq(records.applicableDate, date),
        isNull(records.hiddenAt),
      ),
    );
}

/** The connectors feeding a project, with each stream's sync position (system). */
export async function projectCoverageInputs(tx: Tx, projectId: string) {
  return tx
    .select({
      connectorAccountId: connectorAccounts.id,
      source: connectorAccounts.source,
      createdAt: connectorAccounts.createdAt,
      stream: syncStates.stream,
      lastSuccessAt: syncStates.lastSuccessAt,
      lastAttemptAt: syncStates.lastAttemptAt,
      lastError: syncStates.lastError,
      historyFloor: syncStates.historyFloor,
    })
    .from(projectSources)
    .innerJoin(connectorAccounts, eq(connectorAccounts.id, projectSources.connectorAccountId))
    .leftJoin(syncStates, eq(syncStates.connectorAccountId, connectorAccounts.id))
    .where(and(eq(projectSources.projectId, projectId), isNull(connectorAccounts.disconnectedAt)));
}

export async function getBundle(
  tx: Tx,
  projectId: string,
  date: string,
): Promise<BundleRow | null> {
  const rows = await tx
    .select()
    .from(dailyBundles)
    .where(and(eq(dailyBundles.projectId, projectId), eq(dailyBundles.date, date)))
    .limit(1);
  return rows[0] ?? null;
}

export async function bundlesInRange(
  tx: Tx,
  projectId: string,
  from: string,
  to: string,
): Promise<BundleRow[]> {
  return tx
    .select()
    .from(dailyBundles)
    .where(
      and(
        eq(dailyBundles.projectId, projectId),
        gte(dailyBundles.date, from),
        lte(dailyBundles.date, to),
      ),
    );
}

/** Write a bundle and its items, replacing what was there; clears `dirty_since`. */
export async function saveBundle(
  tx: Tx,
  b: {
    workspaceId: string;
    projectId: string;
    date: string;
    contentHash: string;
    coverage: Record<string, unknown>;
    revisionIds: string[];
    builtAt: Date;
  },
): Promise<{ id: string; changed: boolean }> {
  const existing = await getBundle(tx, b.projectId, b.date);
  if (existing && existing.contentHash === b.contentHash) {
    await tx
      .update(dailyBundles)
      .set({ builtAt: b.builtAt, dirtySince: null })
      .where(eq(dailyBundles.id, existing.id));
    return { id: existing.id, changed: false };
  }
  const id = existing?.id ?? newId();
  if (existing) {
    await tx
      .update(dailyBundles)
      .set({
        contentHash: b.contentHash,
        coverage: b.coverage,
        builtAt: b.builtAt,
        dirtySince: null,
      })
      .where(eq(dailyBundles.id, id));
    await tx.delete(bundleItems).where(eq(bundleItems.bundleId, id));
  } else {
    await tx.insert(dailyBundles).values({
      id,
      workspaceId: b.workspaceId,
      projectId: b.projectId,
      date: b.date,
      contentHash: b.contentHash,
      coverage: b.coverage,
      builtAt: b.builtAt,
    });
  }
  for (let i = 0; i < b.revisionIds.length; i += 500) {
    await tx.insert(bundleItems).values(
      b.revisionIds.slice(i, i + 500).map((rid) => ({
        bundleId: id,
        recordRevisionId: rid,
        workspaceId: b.workspaceId,
      })),
    );
  }
  return { id, changed: true };
}

/**
 * Days of a project that need a (re)build: dirty bundles on any date, and dates with records
 * but no bundle yet (e.g. after an import or a backfill).
 */
export async function staleDays(tx: Tx, projectId: string): Promise<string[]> {
  const dirty = await tx
    .select({ date: dailyBundles.date })
    .from(dailyBundles)
    .where(and(eq(dailyBundles.projectId, projectId), isNotNull(dailyBundles.dirtySince)));
  const missing = await tx.execute<{ date: string }>(sql`
    select distinct r.applicable_date::text as date from records r
    where r.project_id = ${projectId} and r.hidden_at is null
      and not exists (select 1 from daily_bundles b
                      where b.project_id = r.project_id and b.date = r.applicable_date)`);
  return [...new Set([...dirty.map((d) => d.date), ...missing.rows.map((m) => m.date)])].sort();
}

/** Revision IDs in a bundle the caller can see (under RLS). */
export async function bundleItemCount(tx: Tx, bundleIds: string[]): Promise<Map<string, number>> {
  if (!bundleIds.length) return new Map();
  const rows = await tx
    .select({ bundleId: bundleItems.bundleId, n: sql<number>`count(*)::int` })
    .from(bundleItems)
    .where(inArray(bundleItems.bundleId, bundleIds))
    .groupBy(bundleItems.bundleId);
  return new Map(rows.map((r) => [r.bundleId, Number(r.n)]));
}
