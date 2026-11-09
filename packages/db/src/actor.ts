import { sql } from 'drizzle-orm';
import type { HubDb } from './client';

export interface Actor {
  userId: string;
  workspaceId: string;
}

export type Tx = Parameters<Parameters<HubDb['transaction']>[0]>[0];

/**
 * Run `fn` in a transaction as `actor`, under row-level security (schema.md §9).
 * Every service-layer query goes through here. The role and settings are transaction-local,
 * so a pooled connection never leaks one user's identity into the next request.
 */
export function withActor<T>(db: HubDb, actor: Actor, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`set local role hub_app`);
    await tx.execute(
      sql`select set_config('app.user_id', ${actor.userId}, true), set_config('app.workspace_id', ${actor.workspaceId}, true)`,
    );
    return fn(tx);
  });
}

/** Run `fn` as the `hub_auth` role: sign-in tables only, no user context. */
export function withAuthRole<T>(db: HubDb, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`set local role hub_auth`);
    return fn(tx);
  });
}
