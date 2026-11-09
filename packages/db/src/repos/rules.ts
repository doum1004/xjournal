import { and, asc, desc, eq, isNull, or } from 'drizzle-orm';
import type { Tx } from '../actor';
import { projectRules, recordRevisions, records } from '../schema';

// Project rules (schema.md §4, spec §8.4). Members read; managers and the workspace owner
// write. There's no delete: a removed rule is deactivated.

export type RuleRow = typeof projectRules.$inferSelect;

export async function listRules(
  tx: Tx,
  opts: { includeInactive?: boolean } = {},
): Promise<RuleRow[]> {
  return tx
    .select()
    .from(projectRules)
    .where(opts.includeInactive ? undefined : eq(projectRules.active, true))
    .orderBy(asc(projectRules.priority), asc(projectRules.createdAt));
}

export async function getRule(tx: Tx, id: string): Promise<RuleRow | null> {
  const rows = await tx.select().from(projectRules).where(eq(projectRules.id, id)).limit(1);
  return rows[0] ?? null;
}

export async function insertRule(tx: Tx, row: typeof projectRules.$inferInsert): Promise<void> {
  await tx.insert(projectRules).values(row);
}

/** Update only if the row is still at `version`; returns false on a conflict or no access. */
export async function updateRule(
  tx: Tx,
  id: string,
  version: number,
  patch: Partial<Pick<RuleRow, 'projectId' | 'priority' | 'match' | 'active'>>,
): Promise<boolean> {
  const rows = await tx
    .update(projectRules)
    .set({ ...patch, version: version + 1 })
    .where(and(eq(projectRules.id, id), eq(projectRules.version, version)))
    .returning({ id: projectRules.id });
  return rows.length > 0;
}

/** The caller's Inbox with each record's current payload (for rule matching). */
export async function inboxWithPayload(tx: Tx, userId: string, limit = 5000) {
  return tx
    .select({
      id: records.id,
      source: records.source,
      kind: records.kind,
      title: records.title,
      applicableDate: records.applicableDate,
      payload: recordRevisions.payload,
    })
    .from(records)
    .innerJoin(recordRevisions, eq(recordRevisions.id, records.currentRevisionId))
    .where(
      and(
        eq(records.ownerUserId, userId),
        or(isNull(records.projectId), eq(records.routingStatus, 'needs_review')),
        isNull(records.hiddenAt),
      ),
    )
    .orderBy(desc(records.id))
    .limit(limit);
}
