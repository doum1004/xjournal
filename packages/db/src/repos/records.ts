import type {
  InputTier,
  NoteKind,
  RecordKind,
  RoutedBy,
  RoutingStatus,
  Visibility,
} from '@xjournal/core';
import { and, desc, eq, gte, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import type { Tx } from '../actor';
import { recordRevisions, records, recordTags } from '../schema';

// Records and their append-only revisions (schema.md §5). Every function runs inside
// `withActor`; RLS decides what the caller sees and may change (schema.md §9).

export type RecordRow = typeof records.$inferSelect;
export type RevisionRow = typeof recordRevisions.$inferSelect;

export interface NewRecord {
  id: string;
  workspaceId: string;
  source: string;
  externalId: string;
  kind: RecordKind;
  tier: InputTier;
  ownerUserId: string;
  isMine: boolean;
  eventTime: Date;
  capturedAt: Date;
  enteredAt?: Date;
  applicableDate: string;
  projectId: string | null;
  routingStatus: RoutingStatus;
  routedBy: RoutedBy;
  routingConfidence?: number;
  noteKind?: NoteKind;
  parentRecordId?: string;
  visibility: Visibility;
  title: string;
  url?: string;
  summary?: string;
}

export interface NewRevision {
  id: string;
  kind: 'created' | 'content' | 'metadata';
  contentHash: string;
  title: string;
  summary?: string;
  payload: Record<string, unknown>;
  changedBy: string | null;
}

/** Insert a record with revision 1 and its tags. The record row comes first: the revision
 *  policy checks that the caller may edit the record it belongs to. */
export async function insertRecord(
  tx: Tx,
  record: NewRecord,
  revision: NewRevision,
  tags: string[] = [],
): Promise<void> {
  await tx.insert(records).values({ ...record, currentRevisionId: revision.id });
  await tx.insert(recordRevisions).values({
    ...revision,
    recordId: record.id,
    workspaceId: record.workspaceId,
    revisionNo: 1,
    projectId: record.projectId,
    applicableDate: record.applicableDate,
    visibility: record.visibility,
    noteKind: record.noteKind ?? null,
  });
  await replaceTags(tx, record.id, record.workspaceId, tags);
}

export async function getRecord(tx: Tx, id: string): Promise<RecordRow | null> {
  const rows = await tx.select().from(records).where(eq(records.id, id)).limit(1);
  return rows[0] ?? null;
}

export async function getRecords(tx: Tx, ids: string[]): Promise<RecordRow[]> {
  if (ids.length === 0) return [];
  return tx.select().from(records).where(inArray(records.id, ids));
}

export async function getRevision(tx: Tx, id: string): Promise<RevisionRow | null> {
  const rows = await tx.select().from(recordRevisions).where(eq(recordRevisions.id, id)).limit(1);
  return rows[0] ?? null;
}

/** Revision numbers keyed by revision ID, for building views. */
export async function revisionNumbers(tx: Tx, ids: string[]): Promise<Map<string, number>> {
  if (ids.length === 0) return new Map();
  const rows = await tx
    .select({ id: recordRevisions.id, no: recordRevisions.revisionNo })
    .from(recordRevisions)
    .where(inArray(recordRevisions.id, ids));
  return new Map(rows.map((r) => [r.id, r.no]));
}

export async function listRevisions(tx: Tx, recordId: string): Promise<RevisionRow[]> {
  return tx
    .select()
    .from(recordRevisions)
    .where(eq(recordRevisions.recordId, recordId))
    .orderBy(recordRevisions.revisionNo);
}

export type RecordPatch = Partial<
  Pick<
    RecordRow,
    | 'title'
    | 'url'
    | 'summary'
    | 'projectId'
    | 'applicableDate'
    | 'noteKind'
    | 'visibility'
    | 'routingStatus'
    | 'routedBy'
    | 'routingConfidence'
  >
>;

/**
 * Add the next revision and bring the record's current state up to date with it.
 * The revision stores the metadata as it is *after* the change (schema.md §5).
 */
export async function appendRevision(
  tx: Tx,
  current: RecordRow,
  revision: NewRevision,
  patch: RecordPatch,
): Promise<number> {
  const last = await tx
    .select({ no: sql<number>`max(${recordRevisions.revisionNo})` })
    .from(recordRevisions)
    .where(eq(recordRevisions.recordId, current.id));
  const revisionNo = (last[0]?.no ?? 0) + 1;
  const next = { ...current, ...patch };
  await tx.insert(recordRevisions).values({
    ...revision,
    recordId: current.id,
    workspaceId: current.workspaceId,
    revisionNo,
    projectId: next.projectId,
    applicableDate: next.applicableDate,
    visibility: next.visibility,
    noteKind: next.noteKind,
  });
  await tx
    .update(records)
    .set({ ...patch, currentRevisionId: revision.id })
    .where(eq(records.id, current.id));
  return revisionNo;
}

export async function tagsFor(tx: Tx, ids: string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (ids.length === 0) return out;
  const rows = await tx
    .select({ recordId: recordTags.recordId, tag: recordTags.tag })
    .from(recordTags)
    .where(inArray(recordTags.recordId, ids))
    .orderBy(recordTags.tag);
  for (const r of rows) out.set(r.recordId, [...(out.get(r.recordId) ?? []), r.tag]);
  return out;
}

export async function replaceTags(
  tx: Tx,
  recordId: string,
  workspaceId: string,
  tags: string[],
): Promise<void> {
  await tx.delete(recordTags).where(eq(recordTags.recordId, recordId));
  const unique = [...new Set(tags)];
  if (unique.length > 0) {
    await tx.insert(recordTags).values(unique.map((tag) => ({ recordId, tag, workspaceId })));
  }
}

/**
 * The caller's Inbox (schema.md §10): their own records with no project, or flagged for
 * review. Newest first; `before` is the last ID of the previous page (IDs sort by time).
 */
export async function listInbox(
  tx: Tx,
  userId: string,
  opts: { limit: number; before?: string },
): Promise<RecordRow[]> {
  return tx
    .select()
    .from(records)
    .where(
      and(
        eq(records.ownerUserId, userId),
        or(isNull(records.projectId), eq(records.routingStatus, 'needs_review')),
        isNull(records.hiddenAt),
        opts.before ? lt(records.id, opts.before) : undefined,
      ),
    )
    .orderBy(desc(records.id))
    .limit(opts.limit);
}

export interface SearchOptions {
  q: string;
  projectId?: string;
  from?: string;
  to?: string;
  kinds?: RecordKind[];
  limit: number;
  offset: number;
}

/** Full-text search over title and summary (`records.search_tsv`, schema.md §5). */
export async function searchRecords(
  tx: Tx,
  opts: SearchOptions,
): Promise<{ row: RecordRow; score: number }[]> {
  const query = sql`websearch_to_tsquery('simple', ${opts.q})`;
  const score = sql<number>`ts_rank(${records.searchTsv}, ${query})`;
  const rows = await tx
    .select({ row: records, score })
    .from(records)
    .where(
      and(
        sql`${records.searchTsv} @@ ${query}`,
        isNull(records.hiddenAt),
        opts.projectId ? eq(records.projectId, opts.projectId) : undefined,
        opts.from ? gte(records.applicableDate, opts.from) : undefined,
        opts.to ? lt(records.applicableDate, opts.to) : undefined,
        opts.kinds?.length ? inArray(records.kind, opts.kinds) : undefined,
      ),
    )
    .orderBy(desc(score), desc(records.applicableDate), desc(records.id))
    .limit(opts.limit)
    .offset(opts.offset);
  return rows.map((r) => ({ row: r.row, score: Number(r.score) }));
}

/** Existing records for `(source, external_id)` keys in the caller's workspace (schema.md §1). */
export async function findBySourceKeys(
  tx: Tx,
  source: string,
  externalIds: string[],
): Promise<Map<string, RecordRow>> {
  const out = new Map<string, RecordRow>();
  for (let i = 0; i < externalIds.length; i += 500) {
    const chunk = externalIds.slice(i, i + 500);
    const rows = await tx
      .select()
      .from(records)
      .where(and(eq(records.source, source), inArray(records.externalId, chunk)));
    for (const r of rows) out.set(r.externalId, r);
  }
  return out;
}

/** Record counts per applicable date in a project (api.md §3.4), visible ones only. */
export async function dayCounts(
  tx: Tx,
  opts: { projectId: string; userId: string; from: string; to: string },
): Promise<{ date: string; recordCount: number; mineCount: number }[]> {
  const rows = await tx
    .select({
      date: records.applicableDate,
      recordCount: sql<number>`count(*)::int`,
      mineCount: sql<number>`(count(*) filter (where ${records.isMine} and ${records.ownerUserId} = ${opts.userId}))::int`,
    })
    .from(records)
    .where(
      and(
        eq(records.projectId, opts.projectId),
        gte(records.applicableDate, opts.from),
        lt(records.applicableDate, opts.to),
        isNull(records.hiddenAt),
      ),
    )
    .groupBy(records.applicableDate)
    .orderBy(records.applicableDate);
  return rows.map((r) => ({
    ...r,
    recordCount: Number(r.recordCount),
    mineCount: Number(r.mineCount),
  }));
}

/** A day's records in a project, in event order. */
export async function recordsOnDay(tx: Tx, projectId: string, date: string): Promise<RecordRow[]> {
  return tx
    .select()
    .from(records)
    .where(
      and(
        eq(records.projectId, projectId),
        eq(records.applicableDate, date),
        isNull(records.hiddenAt),
      ),
    )
    .orderBy(records.eventTime, records.id);
}
