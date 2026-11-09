import type { Visibility } from '@xjournal/core';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import type { Tx } from '../actor';
import { connectorAccounts, identities, projectSources, syncStates } from '../schema';

// Connector accounts, the projects they feed, their sync positions, and the caller's
// identities in each source (schema.md §4). RLS limits all of these to the owner.

export type ConnectorAccountRow = typeof connectorAccounts.$inferSelect;
export type SyncStateRow = typeof syncStates.$inferSelect;
export type IdentityRow = typeof identities.$inferSelect;

export interface NewConnectorAccount {
  id: string;
  workspaceId: string;
  ownerUserId: string;
  source: string;
  displayName: string;
  authType: string;
  secretRef: string | null;
  scopes?: string[];
  config: Record<string, unknown>;
}

export async function insertAccount(tx: Tx, a: NewConnectorAccount): Promise<void> {
  await tx.insert(connectorAccounts).values(a);
}

/** Connected (not disconnected) accounts, oldest first. */
export async function listAccounts(
  tx: Tx,
  opts: { includeDisconnected?: boolean } = {},
): Promise<ConnectorAccountRow[]> {
  return tx
    .select()
    .from(connectorAccounts)
    .where(opts.includeDisconnected ? undefined : isNull(connectorAccounts.disconnectedAt))
    .orderBy(asc(connectorAccounts.createdAt), asc(connectorAccounts.id));
}

export async function getAccount(tx: Tx, id: string): Promise<ConnectorAccountRow | null> {
  const rows = await tx
    .select()
    .from(connectorAccounts)
    .where(eq(connectorAccounts.id, id))
    .limit(1);
  return rows[0] ?? null;
}

export async function updateAccount(
  tx: Tx,
  id: string,
  patch: Partial<
    Pick<ConnectorAccountRow, 'status' | 'displayName' | 'config' | 'disconnectedAt' | 'secretRef'>
  >,
): Promise<void> {
  await tx.update(connectorAccounts).set(patch).where(eq(connectorAccounts.id, id));
}

export async function attachProject(
  tx: Tx,
  row: {
    projectId: string;
    connectorAccountId: string;
    workspaceId: string;
    addedBy: string;
    defaultVisibility?: Visibility;
  },
): Promise<void> {
  await tx.insert(projectSources).values(row).onConflictDoNothing();
}

export async function projectSourcesFor(tx: Tx, connectorAccountId: string) {
  return tx
    .select({
      projectId: projectSources.projectId,
      defaultVisibility: projectSources.defaultVisibility,
    })
    .from(projectSources)
    .where(eq(projectSources.connectorAccountId, connectorAccountId))
    .orderBy(asc(projectSources.addedAt));
}

export async function syncStatesFor(tx: Tx, connectorAccountId: string): Promise<SyncStateRow[]> {
  return tx
    .select()
    .from(syncStates)
    .where(eq(syncStates.connectorAccountId, connectorAccountId))
    .orderBy(asc(syncStates.stream));
}

export async function getSyncState(
  tx: Tx,
  connectorAccountId: string,
  stream: string,
): Promise<SyncStateRow | null> {
  const rows = await tx
    .select()
    .from(syncStates)
    .where(
      and(eq(syncStates.connectorAccountId, connectorAccountId), eq(syncStates.stream, stream)),
    )
    .limit(1);
  return rows[0] ?? null;
}

/** Create or update one stream's position. Only the fields given are changed. */
export async function saveSyncState(
  tx: Tx,
  key: { connectorAccountId: string; stream: string; workspaceId: string },
  patch: Partial<
    Pick<SyncStateRow, 'cursor' | 'lastSuccessAt' | 'lastAttemptAt' | 'lastError' | 'historyFloor'>
  >,
): Promise<void> {
  await tx
    .insert(syncStates)
    .values({ ...key, ...patch })
    .onConflictDoUpdate({
      target: [syncStates.connectorAccountId, syncStates.stream],
      // An empty patch still needs one assignment to be valid SQL.
      set: Object.keys(patch).length ? patch : { stream: sql`excluded.stream` },
    });
}

export async function listIdentities(tx: Tx, source?: string): Promise<IdentityRow[]> {
  return tx
    .select()
    .from(identities)
    .where(source ? eq(identities.source, source) : undefined)
    .orderBy(asc(identities.source), asc(identities.accountKey));
}

export async function insertIdentity(
  tx: Tx,
  row: {
    id: string;
    workspaceId: string;
    userId: string;
    source: string;
    accountKey: string;
    aliases: string[];
  },
): Promise<void> {
  await tx.insert(identities).values(row);
}

export async function deleteIdentity(tx: Tx, id: string): Promise<boolean> {
  const rows = await tx
    .delete(identities)
    .where(eq(identities.id, id))
    .returning({ id: identities.id });
  return rows.length > 0;
}
