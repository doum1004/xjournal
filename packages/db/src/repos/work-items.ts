import { newId } from '@xjournal/core';
import { and, asc, desc, eq, gte, inArray, isNull, notExists, or, sql } from 'drizzle-orm';
import type { Tx } from '../actor';
import { recordRevisions, records, workItemAiChecks, workItemLinks, workItems } from '../schema';

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
  /** AI guesses dropped because a rule now links their record. */
  guessesDropped: number;
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
  const all = existing.length
    ? await tx
        .select({
          workItemId: workItemLinks.workItemId,
          recordId: workItemLinks.recordId,
          origin: workItemLinks.origin,
        })
        .from(workItemLinks)
        .where(
          inArray(
            workItemLinks.workItemId,
            existing.map((w) => w.id),
          ),
        )
    : [];
  const current = all.filter((l) => l.origin === 'rule');
  // A pair a user already linked needs no rule link; an AI guess gives way to one (below).
  const have = new Set(
    all.filter((l) => l.origin !== 'ai').map((l) => `${l.workItemId}|${l.recordId}`),
  );
  const want = new Set<string>();
  const result: SaveLinksResult = {
    items: planned.length,
    created: 0,
    linksAdded: 0,
    linksRemoved: 0,
    guessesDropped: 0,
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
  // A record a rule links is placed by what it says; guesses about it are superseded.
  const ruled = new Set([...want].map((k) => k.split('|')[1] as string));
  const guesses = all.filter((l) => l.origin === 'ai' && ruled.has(l.recordId));
  for (const g of guesses) {
    await tx
      .delete(workItemLinks)
      .where(
        and(
          eq(workItemLinks.workItemId, g.workItemId),
          eq(workItemLinks.recordId, g.recordId),
          eq(workItemLinks.origin, 'ai'),
        ),
      );
  }
  result.guessesDropped = guesses.length;
  for (let i = 0; i < toInsert.length; i += 500) {
    // A 'user' link to the same pair already says it; keep that one.
    await tx
      .insert(workItemLinks)
      .values(toInsert.slice(i, i + 500))
      .onConflictDoNothing();
  }
  result.linksAdded = toInsert.length;
  return result;
}

export interface LinkRow {
  recordId: string;
  workItemId: string;
  origin: 'rule' | 'ai' | 'user';
  confidence: number | null;
}

/** The work items of these records the caller can see (under RLS). */
export async function linksOf(tx: Tx, recordIds: string[]): Promise<LinkRow[]> {
  if (!recordIds.length) return [];
  const out: LinkRow[] = [];
  for (let i = 0; i < recordIds.length; i += 1000) {
    out.push(
      ...(await tx
        .select({
          recordId: workItemLinks.recordId,
          workItemId: workItemLinks.workItemId,
          origin: workItemLinks.origin,
          confidence: workItemLinks.confidence,
        })
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

// ------------------------------------------------------------------------------------------
// AI-suggested links (docs/adr/0009), system side
// ------------------------------------------------------------------------------------------

/**
 * Records since `since` that are in no work item and that the model hasn't seen at their
 * current revision (system).
 */
export async function aiCandidates(tx: Tx, projectId: string, since: Date) {
  return tx
    .select({
      id: records.id,
      revisionId: records.currentRevisionId,
      source: records.source,
      kind: records.kind,
      noteKind: records.noteKind,
      title: records.title,
      summary: records.summary,
      eventTime: records.eventTime,
    })
    .from(records)
    .leftJoin(workItemAiChecks, eq(workItemAiChecks.recordId, records.id))
    .where(
      and(
        eq(records.projectId, projectId),
        isNull(records.hiddenAt),
        gte(records.eventTime, since),
        or(
          isNull(workItemAiChecks.recordId),
          sql`${workItemAiChecks.revisionId} <> ${records.currentRevisionId}`,
        ),
        notExists(
          tx
            .select({ one: sql`1` })
            .from(workItemLinks)
            .where(eq(workItemLinks.recordId, records.id)),
        ),
      ),
    )
    .orderBy(asc(records.eventTime), asc(records.id));
}

export interface ActiveItem {
  id: string;
  key: string | null;
  title: string;
  /** Titles of its latest records, newest first. */
  records: string[];
}

/**
 * Work items of a project with a record since `since`, each with the titles of its latest
 * records (system): what the model may place a record in.
 */
export async function activeItems(
  tx: Tx,
  projectId: string,
  since: Date,
  perItem = 4,
): Promise<ActiveItem[]> {
  const active = tx
    .select({ id: workItemLinks.workItemId })
    .from(workItemLinks)
    .innerJoin(records, eq(records.id, workItemLinks.recordId))
    .where(
      and(
        eq(records.projectId, projectId),
        gte(records.eventTime, since),
        isNull(records.hiddenAt),
      ),
    );
  const rows = await tx
    .select({
      id: workItems.id,
      key: workItems.key,
      title: workItems.title,
      recordTitle: records.title,
    })
    .from(workItems)
    .innerJoin(workItemLinks, eq(workItemLinks.workItemId, workItems.id))
    .innerJoin(records, eq(records.id, workItemLinks.recordId))
    .where(
      and(
        eq(workItems.projectId, projectId),
        isNull(records.hiddenAt),
        inArray(workItems.id, active),
      ),
    )
    .orderBy(asc(workItems.key), desc(records.eventTime), asc(records.id));
  const out = new Map<string, ActiveItem>();
  for (const r of rows) {
    let item = out.get(r.id);
    if (!item) {
      item = { id: r.id, key: r.key, title: r.title, records: [] };
      out.set(r.id, item);
    }
    if (item.records.length < perItem && !item.records.includes(r.recordTitle)) {
      item.records.push(r.recordTitle);
    }
  }
  return [...out.values()];
}

/**
 * Save the model's links and mark every record it was asked about as checked at the revision
 * it saw (system). A pair already linked by a rule or a user keeps that link.
 */
export async function saveAiLinks(
  tx: Tx,
  workspaceId: string,
  links: { workItemId: string; recordId: string; confidence: number }[],
  checked: { recordId: string; revisionId: string }[],
  now: Date,
): Promise<number> {
  let added = 0;
  if (links.length) {
    const rows = await tx
      .insert(workItemLinks)
      .values(
        links.map((l) => ({
          workItemId: l.workItemId,
          recordId: l.recordId,
          workspaceId,
          origin: 'ai' as const,
          confidence: l.confidence,
          createdAt: now,
        })),
      )
      .onConflictDoNothing()
      .returning({ recordId: workItemLinks.recordId });
    added = rows.length;
  }
  for (let i = 0; i < checked.length; i += 500) {
    await tx
      .insert(workItemAiChecks)
      .values(checked.slice(i, i + 500).map((c) => ({ ...c, workspaceId, checkedAt: now })))
      .onConflictDoUpdate({
        target: workItemAiChecks.recordId,
        set: { revisionId: sql`excluded.revision_id`, checkedAt: now },
      });
  }
  return added;
}
