import { newId } from '@xjournal/core';
import { sql } from 'drizzle-orm';
import { type Actor, withActor, withAuthRole } from '../actor';
import type { HubDb } from '../client';
import { users, workspaces } from '../schema';

// Local mode (spec §11.1): one user, one Work workspace, no account system. `hub init` creates
// them once; the server then acts as that user for every request that carries the local token.

export interface LocalOwner extends Actor {
  displayName: string;
  timeZone: string;
}

/**
 * The local owner, or null before `hub init`. This reads `workspaces` as the connecting
 * (migration) role, outside RLS, because no user is known yet. That role bypasses RLS in
 * local Docker and PGlite; hosted mode never calls this.
 */
export async function findLocalOwner(db: HubDb): Promise<LocalOwner | null> {
  const result = await db.execute<{
    workspace_id: string;
    user_id: string;
    display_name: string;
    time_zone: string;
  }>(sql`
    select w.id as workspace_id, w.owner_user_id as user_id, u.display_name, w.time_zone
    from workspaces w join users u on u.id = w.owner_user_id
    where w.domain = 'work'
    order by w.created_at, w.id
    limit 1`);
  const row = result.rows[0];
  return row
    ? {
        workspaceId: row.workspace_id,
        userId: row.user_id,
        displayName: row.display_name,
        timeZone: row.time_zone,
      }
    : null;
}

export interface BootstrapInput {
  displayName: string;
  timeZone: string;
  workspaceName?: string;
}

/**
 * Create the local owner and their Work workspace, under the same RLS roles the server uses:
 * the user as `hub_auth` (the only role that may create users), the workspace as that user.
 * Idempotent: returns the existing owner if there is one.
 */
export async function bootstrapLocal(
  db: HubDb,
  input: BootstrapInput,
): Promise<{ owner: LocalOwner; created: boolean }> {
  const existing = await findLocalOwner(db);
  if (existing) return { owner: existing, created: false };

  const actor: Actor = { userId: newId(), workspaceId: newId() };
  await withAuthRole(db, (tx) =>
    tx.insert(users).values({ id: actor.userId, displayName: input.displayName }),
  );
  await withActor(db, actor, (tx) =>
    tx.insert(workspaces).values({
      id: actor.workspaceId,
      domain: 'work',
      name: input.workspaceName ?? 'Work',
      ownerUserId: actor.userId,
      timeZone: input.timeZone,
    }),
  );
  return {
    owner: { ...actor, displayName: input.displayName, timeZone: input.timeZone },
    created: true,
  };
}

/** The workspace a signed-in user acts in: the one they own, else their first membership. */
export async function workspaceOfUser(db: HubDb, userId: string): Promise<string | null> {
  const r = await db.execute<{ id: string }>(sql`
    select id from (
      select w.id, 0 as rank, w.id as tiebreak from workspaces w where w.owner_user_id = ${userId}
      union all
      select pm.workspace_id, 1, pm.workspace_id from project_members pm
      where pm.user_id = ${userId} and pm.left_at is null
    ) x order by rank, tiebreak limit 1`);
  return r.rows[0]?.id ?? null;
}
