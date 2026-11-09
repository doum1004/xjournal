import { type Actor, type HubDb, type Tx, withActor } from '@xjournal/db';

/** Who is calling, and the database to call with. Every operation takes one. */
export interface Ctx {
  db: HubDb;
  actor: Actor;
}

/** Run `fn` as the caller, under row-level security (schema.md §9). */
export const asCaller = <T>(ctx: Ctx, fn: (tx: Tx) => Promise<T>) =>
  withActor(ctx.db, ctx.actor, fn);
