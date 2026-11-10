import {
  ConnectorAuthError,
  type Cursor,
  kindOfSource,
  type SyncLog,
  type SyncPage,
} from '@xjournal/connectors';
import { addDays, firstMatch, localDate } from '@xjournal/core';
import { connectorRepo, projectRepo } from '@xjournal/db';
import { redact } from '@xjournal/secrets';
import { type ConnectorDeps, connectorConfigOf, identityResolver, messageOf } from './connectors';
import { asCaller, type Ctx } from './context';
import { notFound, ServiceError } from './errors';
import {
  emptyResult,
  type IngestResult,
  mapDuplicateKey,
  validateRecords,
  type WriteTarget,
  writeRecords,
} from './ingest';
import { workspaceTimeZone } from './projects';
import { routingRules } from './rules';

// The sync runner (spec §8.1): for each stream of a connector account, page from the stored
// cursor, write each page's records and its cursor in one transaction (so a crash resumes
// exactly where it stopped), and record status, errors and the history floor.

export interface SyncOptions {
  /** Only these streams (default: all the connector declares). */
  streams?: string[];
  /** Stop a stream after this many pages; the next sync carries on from its cursor. */
  maxPages?: number;
  /** First-sync start date, overriding the account's `backfillFrom`. */
  backfillFrom?: string;
  now?: Date;
  signal?: AbortSignal;
}

export interface StreamSyncResult extends IngestResult {
  stream: string;
  pages: number;
  /** More pages remain (stopped at `maxPages`). */
  more: boolean;
  error: string | null;
  historyFloor: string | null;
}

export interface SyncResult {
  connectorAccountId: string;
  source: string;
  status: 'ok' | 'error';
  streams: StreamSyncResult[];
  warnings: string[];
}

/** Without a cursor or a configured start, a first sync reaches back this far. */
export const DEFAULT_BACKFILL_DAYS = 30;
const DEFAULT_MAX_PAGES = 1000;

const quietLog: SyncLog = { info() {}, warn() {} };

export async function syncConnector(
  ctx: Ctx,
  deps: ConnectorDeps,
  connectorAccountId: string,
  opts: SyncOptions = {},
): Promise<SyncResult> {
  const now = opts.now ?? new Date();
  const log = deps.log ?? quietLog;

  // Load everything the run needs, and mark it running.
  const setup = await asCaller(ctx, async (tx) => {
    const account = await connectorRepo.getAccount(tx, connectorAccountId);
    if (!account || account.disconnectedAt) throw notFound('Connector not found');
    const wsTz = await workspaceTimeZone(tx);
    const sources = await connectorRepo.projectSourcesFor(tx, account.id);
    // Exactly one project: file there. None or several: the Inbox, until project rules
    // (spec §8.4) decide.
    const only = sources.length === 1 ? sources[0] : undefined;
    const project = only ? await projectRepo.findProject(tx, only.projectId) : null;
    const identities = await connectorRepo.listIdentities(tx, account.source);
    const rules = await routingRules(tx);
    await connectorRepo.updateAccount(tx, account.id, { status: 'running' });
    return {
      account,
      identities,
      rules,
      wsTz,
      timeZone: project?.timeZone ?? wsTz,
      project: project && only ? { id: project.id, visibility: only.defaultVisibility } : null,
    };
  });
  const { account } = setup;

  const result: SyncResult = {
    connectorAccountId: account.id,
    source: account.source,
    status: 'ok',
    streams: [],
    warnings: [],
  };
  let secret: string | null = null;
  // Every credential this sync has held, so a rotated one is redacted from errors too.
  const seen: (string | null)[] = [];

  const finish = async (status: 'ok' | 'error') => {
    result.status = status;
    await asCaller(ctx, (tx) => connectorRepo.updateAccount(tx, account.id, { status }));
    return result;
  };

  try {
    const connector = deps.registry.get(kindOfSource(account.source));
    if (!connector) {
      throw new ServiceError(400, 'bad_request', `No connector for ${account.source}`);
    }
    const desc = connector.describe();
    const config = connector.parseConfig(connectorConfigOf(account.config));
    if (account.secretRef) {
      secret = await deps.secrets.get(account.secretRef);
      seen.push(...secretParts(secret));
      if (secret == null) {
        throw new ConnectorAuthError('The credential is missing from the secret store; reconnect');
      }
    }
    if (setup.identities.length === 0) {
      result.warnings.push(
        `No identities mapped for ${account.source}: nothing will count as yours. ` +
          `Add one with \`hub identity add ${account.source} <login>\`.`,
      );
    }

    const streams = opts.streams ?? desc.streams.map((s) => s.key);
    const unknown = streams.filter((s) => !desc.streams.some((d) => d.key === s));
    if (unknown.length) {
      throw new ServiceError(400, 'bad_request', `Unknown streams: ${unknown.join(', ')}`);
    }

    const accountBackfill = (account.config as { backfillFrom?: string }).backfillFrom;
    const backfillFrom =
      opts.backfillFrom ??
      accountBackfill ??
      addDays(
        localDate(now, setup.timeZone),
        -(desc.policy.historyLimitDays ?? DEFAULT_BACKFILL_DAYS),
      );

    const target: WriteTarget = {
      source: account.source,
      tier: 'builtin',
      connectorAccountId: account.id,
      project: setup.project,
      routingStatus: setup.project ? 'auto' : 'needs_review',
      routedBy: 'connector',
      timeZone: setup.timeZone,
      whoIs: identityResolver(setup.identities),
      routeFor: (r) => {
        const m = firstMatch(setup.rules, {
          source: account.source,
          kind: r.kind,
          title: r.title,
          payload: r.payload ?? null,
        });
        return m
          ? {
              project: { id: m.project.id, visibility: m.project.visibility },
              timeZone: m.project.timeZone ?? setup.wsTz,
            }
          : null;
      },
    };
    const key = { connectorAccountId: account.id, workspaceId: ctx.actor.workspaceId };
    const saveSecret = (ref: string) => async (value: string) => {
      await deps.secrets.set(ref, value);
      secret = value;
      seen.push(...secretParts(value));
    };

    let authFailed = false;
    for (const stream of streams) {
      const sr: StreamSyncResult = {
        stream,
        ...emptyResult(),
        pages: 0,
        more: false,
        error: null,
        historyFloor: null,
      };
      result.streams.push(sr);
      if (authFailed) {
        sr.error = 'skipped: the credential was refused';
        continue;
      }

      const state = await asCaller(ctx, async (tx) => {
        const s = await connectorRepo.getSyncState(tx, account.id, stream);
        await connectorRepo.saveSyncState(tx, { ...key, stream }, { lastAttemptAt: now });
        return s;
      });
      let cursor = (state?.cursor ?? null) as Cursor;

      try {
        const maxPages = opts.maxPages ?? DEFAULT_MAX_PAGES;
        while (sr.pages < maxPages) {
          opts.signal?.throwIfAborted();
          const page: SyncPage = await connector.sync({
            config,
            secret,
            stream,
            cursor,
            identities: setup.identities.map((i) => ({
              accountKey: i.accountKey,
              aliases: i.aliases,
            })),
            backfillFrom,
            now,
            fetch: deps.fetch ?? fetch,
            log,
            ...(opts.signal ? { signal: opts.signal } : {}),
            ...(account.secretRef ? { saveSecret: saveSecret(account.secretRef) } : {}),
          });
          sr.pages++;
          const valid = validateRecords(page.records, 'builtin', sr);
          await asCaller(ctx, async (tx) => {
            await writeRecords(tx, ctx, valid, target, sr, now);
            await connectorRepo.saveSyncState(
              tx,
              { ...key, stream },
              {
                cursor: page.cursor,
                ...(page.historyFloor ? { historyFloor: page.historyFloor } : {}),
              },
            );
          }).catch(mapDuplicateKey);
          cursor = page.cursor;
          if (page.historyFloor) sr.historyFloor = page.historyFloor.toISOString();
          sr.more = page.more;
          if (!page.more) break;
        }
        await asCaller(ctx, (tx) =>
          connectorRepo.saveSyncState(
            tx,
            { ...key, stream },
            { lastSuccessAt: now, lastError: null },
          ),
        );
      } catch (e) {
        // Keep credentials out of the database and logs, even if the source echoed them.
        sr.error = redact(messageOf(e), seen);
        if (e instanceof ConnectorAuthError) authFailed = true;
        log.warn('sync stream failed', { source: account.source, stream, error: sr.error });
        await asCaller(ctx, (tx) =>
          connectorRepo.saveSyncState(tx, { ...key, stream }, { lastError: sr.error }),
        );
      }
    }
    return await finish(result.streams.some((s) => s.error) ? 'error' : 'ok');
  } catch (e) {
    // Setup failed before any stream ran (bad config, missing credential, unknown stream).
    await finish('error');
    if (e instanceof ServiceError) throw e;
    // A refused source credential is not the hub caller's auth failing, so never a 401.
    throw new ServiceError(400, 'bad_request', redact(messageOf(e), seen));
  }
}

/** A secret and, for a JSON credential (OAuth), each of its values, for redaction. */
function secretParts(secret: string | null): string[] {
  if (!secret) return [];
  try {
    const v: unknown = JSON.parse(secret);
    if (v && typeof v === 'object') {
      return [secret, ...Object.values(v).filter((x): x is string => typeof x === 'string')];
    }
  } catch {}
  return [secret];
}
