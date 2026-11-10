import { connectorRepo, type HubDb, withSystem } from '@xjournal/db';
import { type RebuildSummary, rebuildBundles } from './bundles';
import type { ConnectorDeps } from './connectors';
import { messageOf } from './connectors';
import { markStaleReports } from './reports';
import { type SyncResult, syncConnector } from './sync';
import { type RelinkSummary, relinkWorkItems } from './workitems';

// The morning run (spec §5.1, Flow A steps 2–3): sync every connector incrementally, then
// relink work items (spec §3.5), then rebuild the bundles of the catch-up window and of every
// stale day. Report generation (step 4) joins it in M3. One run at a time: the scheduler
// enqueues it with a singleton key.

export interface MorningRunOptions {
  now?: Date;
  /** Catch-up window in days (default 14). */
  days?: number;
  /** Skip the sync step (rebuild bundles only). */
  skipSync?: boolean;
}

export interface MorningRunResult {
  startedAt: string;
  finishedAt: string;
  syncs: (
    | SyncResult
    | { connectorAccountId: string; source: string; status: 'error'; error: string }
  )[];
  bundles: RebuildSummary;
  workItems: RelinkSummary;
  /** Reports marked stale by this run. */
  staleReports: number;
}

export async function morningRun(
  db: HubDb,
  deps: ConnectorDeps,
  opts: MorningRunOptions = {},
): Promise<MorningRunResult> {
  const started = new Date();
  const now = opts.now ?? started;
  const syncs: MorningRunResult['syncs'] = [];

  if (!opts.skipSync) {
    const accounts = await withSystem(db, (tx) => connectorRepo.allConnectedAccounts(tx));
    for (const a of accounts) {
      // Each account syncs as its owner, under RLS, like a sync they started themselves.
      const ctx = { db, actor: { userId: a.ownerUserId, workspaceId: a.workspaceId } };
      try {
        syncs.push(await syncConnector(ctx, deps, a.id, { now }));
      } catch (e) {
        deps.log?.warn('morning sync failed', { source: a.source, error: messageOf(e) });
        syncs.push({
          connectorAccountId: a.id,
          source: a.source,
          status: 'error',
          error: messageOf(e),
        });
      }
    }
  }

  const workItems = await relinkWorkItems(db, { now });
  const bundles = await rebuildBundles(db, { now, ...(opts.days ? { days: opts.days } : {}) });
  // Reports built on changed bundles are behind now (schema.md §7).
  const staleReports = await markStaleReports(db);
  return {
    startedAt: started.toISOString(),
    finishedAt: new Date().toISOString(),
    syncs,
    bundles,
    workItems,
    staleReports,
  };
}
