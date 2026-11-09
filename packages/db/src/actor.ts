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

/**
 * Run `fn` in a transaction as the connection's own role (the migration role), which bypasses
 * row-level security. Only for system jobs over derived data, such as building daily bundles,
 * which cover every record of a project and date regardless of who may see them (schema.md
 * §6). Never call it with input a user controls beyond IDs. See docs/adr/0005 for managed
 * Postgres, where this role needs BYPASSRLS.
 */
export function withSystem<T>(db: HubDb, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.transaction(fn);
}
