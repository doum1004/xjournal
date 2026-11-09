import type { DbHandle, HubDb } from '@xjournal/db';
import { type ConnectorDeps, morningRun, rebuildBundles, syncConnector } from '@xjournal/services';
import { fromPglite, PgBoss } from 'pg-boss';

/**
 * The job queue (spec §16.2: pg-boss on the same Postgres). pg-boss owns the `pgboss` schema.
 *
 * - Postgres: pg-boss gets its own small pool from DATABASE_URL, so it can hold the
 *   LISTEN connection it uses for prompt pickup.
 * - PGlite (tests): through pg-boss's PGlite adapter, on the test database itself.
 *
 * See docs/adr/0003.
 */
export function createBoss(handle: DbHandle, connectionString?: string): PgBoss {
  if (handle.kind === 'pglite') {
    if (!handle.pglite) throw new Error('PGlite handle without a client');
    return new PgBoss({ db: fromPglite(handle.pglite), supervise: false, schedule: false });
  }
  if (!connectionString) throw new Error('createBoss: connectionString is required for Postgres');
  return new PgBoss({ connectionString, max: 4, application_name: 'xjournal-jobs' });
}

// ------------------------------------------------------------------------------------------
// Queues and workers (spec §5.1, §11.4 rule 3)
// ------------------------------------------------------------------------------------------

export const MORNING_QUEUE = 'morning-run';
export const SYNC_QUEUE = 'connector-sync';

export interface SyncJob {
  connectorAccountId: string;
  userId: string;
  workspaceId: string;
  backfillFrom?: string;
  streams?: string[];
}

/** What the REST layer needs from the queue. */
export interface Jobs {
  /** `null` when a run is already queued or running. */
  enqueueMorningRun(): Promise<string | null>;
  /** `null` when this account already has a sync queued or running. */
  enqueueSync(job: SyncJob): Promise<string | null>;
}

export interface JobsOptions {
  db: HubDb;
  connectors: ConnectorDeps;
  /** Cron for the morning run, in `timeZone` (default: 07:00 every day). */
  cron?: string;
  timeZone: string;
  log: (level: 'info' | 'warn' | 'error', msg: string, extra?: Record<string, unknown>) => void;
}

/** Create `name` with the 'exclusive' policy, which is what keeps runs from doubling up. */
async function ensureQueue(boss: PgBoss, name: string) {
  const q = await boss.getQueue(name);
  if (!q) {
    await boss.createQueue(name, { policy: 'exclusive' });
  } else if (q.policy !== 'exclusive') {
    throw new Error(
      `Queue ${name} exists with policy '${q.policy}', not 'exclusive'; delete it (pg-boss deleteQueue) and restart`,
    );
  }
}

/** Create the queues, start the workers and (re)write the morning schedule. */
export async function startJobs(boss: PgBoss, opts: JobsOptions): Promise<Jobs> {
  await ensureQueue(boss, MORNING_QUEUE);
  await ensureQueue(boss, SYNC_QUEUE);

  await boss.work(MORNING_QUEUE, async () => {
    const r = await morningRun(opts.db, opts.connectors);
    opts.log('info', 'morning run finished', {
      syncs: r.syncs.map((s) => ({ source: s.source, status: s.status })),
      bundlesBuilt: r.bundles.built,
      bundlesChanged: r.bundles.changed,
    });
  });
  await boss.work<SyncJob>(SYNC_QUEUE, async ([job]) => {
    if (!job) return;
    const d = job.data;
    const ctx = { db: opts.db, actor: { userId: d.userId, workspaceId: d.workspaceId } };
    const r = await syncConnector(ctx, opts.connectors, d.connectorAccountId, {
      ...(d.backfillFrom ? { backfillFrom: d.backfillFrom } : {}),
      ...(d.streams ? { streams: d.streams } : {}),
    });
    // New evidence: bring the affected bundles up to date right away.
    await rebuildBundles(opts.db);
    opts.log('info', 'connector sync finished', { source: r.source, status: r.status });
  });

  await boss.schedule(MORNING_QUEUE, opts.cron ?? '0 7 * * *', null, { tz: opts.timeZone });

  return {
    enqueueMorningRun: () => boss.send(MORNING_QUEUE, {}, { singletonKey: 'morning' }),
    enqueueSync: (job) => boss.send(SYNC_QUEUE, job, { singletonKey: job.connectorAccountId }),
  };
}
