import { and, asc, eq } from 'drizzle-orm';
import type { Tx } from '../actor';
import { careerEntries } from '../schema';

// The career log (spec §9.8). Private to its owner under RLS: every read and write here only
// ever sees the caller's own entries.

export type CareerEntryRow = typeof careerEntries.$inferSelect;

export async function listEntries(tx: Tx, projectId?: string): Promise<CareerEntryRow[]> {
  return tx
    .select()
    .from(careerEntries)
    .where(projectId ? eq(careerEntries.projectId, projectId) : undefined)
    .orderBy(asc(careerEntries.periodStart), asc(careerEntries.projectId));
}

export async function getEntry(tx: Tx, id: string): Promise<CareerEntryRow | null> {
  const rows = await tx.select().from(careerEntries).where(eq(careerEntries.id, id)).limit(1);
  return rows[0] ?? null;
}

export async function findEntry(
  tx: Tx,
  key: { userId: string; projectId: string; periodStart: string },
): Promise<CareerEntryRow | null> {
  const rows = await tx
    .select()
    .from(careerEntries)
    .where(
      and(
        eq(careerEntries.userId, key.userId),
        eq(careerEntries.projectId, key.projectId),
        eq(careerEntries.periodStart, key.periodStart),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

export async function insertEntry(tx: Tx, row: typeof careerEntries.$inferInsert): Promise<void> {
  await tx.insert(careerEntries).values(row);
}

/** Returns false when RLS let nothing through (not yours, or gone). */
export async function updateEntry(
  tx: Tx,
  id: string,
  patch: Partial<
    Pick<CareerEntryRow, 'bodyMd' | 'sourceVersionId' | 'status' | 'approvedAt' | 'updatedAt'>
  >,
): Promise<boolean> {
  const rows = await tx
    .update(careerEntries)
    .set(patch)
    .where(eq(careerEntries.id, id))
    .returning({ id: careerEntries.id });
  return rows.length > 0;
}

export async function deleteEntry(tx: Tx, id: string): Promise<boolean> {
  const rows = await tx
    .delete(careerEntries)
    .where(eq(careerEntries.id, id))
    .returning({ id: careerEntries.id });
  return rows.length > 0;
}
