import { newId } from '@xjournal/core';
import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import type { Tx } from '../actor';
import { recordRevisions, records, workItemLinks, workItems } from '../schema';

// Work items (schema.md §6, spec §3.5). Linking runs in a system transaction (`withSystem`);
// reads in `withActor` see only what the work item policies allow.

export type WorkItemRow = typeof workItems.$inferSelect;

/** What linking reads of each record: every non-hidden record of the project (system). */
export async function linkInputs(tx: Tx, projectId: string) {
  return tx
    .select({
      id: records.id,
      source: records.source,
      kind: records.kind,
      noteKind: records.noteKind,
      title: records.title,
      summary: records.summary,
      url: records.url,
      visibility: records.visibility,
      eventTime: records.eventTime,
      payload: recordRevisions.payload,
    })
    .from(records)
    .innerJoin(recordRevisions, eq(recordRevisions.id, records.currentRevisionId))
    .where(and(eq(records.projectId, projectId), isNull(records.hiddenAt)))
    .orderBy(asc(records.eventTime), asc(records.id));
}

export interface PlannedItem {
  key: string;
  title: string;
  url: string | null;
  recordIds: string[];
}

export interface SaveLinksResult {
  items: number;
  created: number;
  linksAdded: number;
  linksRemoved: number;
}

/**
 * Make a project's rule links match `planned` (system). Items are matched by key, so an item
 * keeps its ID across rebuilds; an item no longer planned keeps its row but loses its rule
 * links. Links of other origins ('ai', 'user') are left alone.
 */
export async function saveRuleLinks(
  tx: Tx,
  project: { id: string; workspaceId: string },
  planned: PlannedItem[],
  now: Date,
): Promise<SaveLinksResult> {
  const existing = await tx.select().from(workItems).where(eq(workItems.projectId, project.id));
  const byKey = new Map(existing.map((w) => [w.key, w]));
  const current = existing.length
    ? await tx
        .select({ workItemId: workItemLinks.workItemId, recordId: workItemLinks.recordId })
        .from(workItemLinks)
        .where(
          and(
            inArray(
              workItemLinks.workItemId,
              existing.map((w) => w.id),
            ),
            eq(workItemLinks.origin, 'rule'),
          ),
        )
    : [];
  const have = new Set(current.map((l) => `${l.workItemId}|${l.recordId}`));
  const want = new Set<string>();
  const result: SaveLinksResult = {
    items: planned.length,
    created: 0,
    linksAdded: 0,
    linksRemoved: 0,
  };
  const toInsert: (typeof workItemLinks.$inferInsert)[] = [];

  for (const p of planned) {
    let item = byKey.get(p.key);
    if (!item) {
      const [row] = await tx
        .insert(workItems)
        .values({
          id: newId(),
          workspaceId: project.workspaceId,
          projectId: project.id,
          key: p.key,
          title: p.title,
          url: p.url,
          createdAt: now,
          updatedAt: now,
        })
        .returning();
      item = row as WorkItemRow;
      result.created++;
    } else if (item.title !== p.title || item.url !== p.url) {
      await tx
        .update(workItems)
        .set({ title: p.title, url: p.url, updatedAt: now })
        .where(eq(workItems.id, item.id));
    }
    for (const rid of p.recordIds) {
      const k = `${item.id}|${rid}`;
      want.add(k);
      if (!have.has(k)) {
        toInsert.push({
          workItemId: item.id,
          recordId: rid,
          workspaceId: project.workspaceId,
          origin: 'rule',
          createdAt: now,
        });
      }
    }
  }

  for (const l of current) {
    if (want.has(`${l.workItemId}|${l.recordId}`)) continue;
    await tx
      .delete(workItemLinks)
      .where(
        and(
          eq(workItemLinks.workItemId, l.workItemId),
          eq(workItemLinks.recordId, l.recordId),
          eq(workItemLinks.origin, 'rule'),
        ),
      );
    result.linksRemoved++;
  }
  for (let i = 0; i < toInsert.length; i += 500) {
    // A 'user' or 'ai' link to the same pair already says it; keep that one.
    await tx
      .insert(workItemLinks)
      .values(toInsert.slice(i, i + 500))
      .onConflictDoNothing();
  }
  result.linksAdded = toInsert.length;
  return result;
}

/** The work items of these records the caller can see (under RLS). */
export async function linksOf(
  tx: Tx,
  recordIds: string[],
): Promise<{ recordId: string; workItemId: string }[]> {
  if (!recordIds.length) return [];
  const out: { recordId: string; workItemId: string }[] = [];
  for (let i = 0; i < recordIds.length; i += 1000) {
    out.push(
      ...(await tx
        .select({ recordId: workItemLinks.recordId, workItemId: workItemLinks.workItemId })
        .from(workItemLinks)
        .innerJoin(workItems, eq(workItems.id, workItemLinks.workItemId))
        .where(inArray(workItemLinks.recordId, recordIds.slice(i, i + 1000)))),
    );
  }
  return out;
}

/** Items by ID, as far as the caller can see them (under RLS). */
export async function itemsByIds(tx: Tx, ids: string[]): Promise<WorkItemRow[]> {
  if (!ids.length) return [];
  return tx.select().from(workItems).where(inArray(workItems.id, ids));
}
