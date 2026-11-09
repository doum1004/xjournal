import {
  type ConfluencePagesConfig,
  type PublishOutcome,
  publishWorklogDay,
} from '@xjournal/connectors';
import { newId, type ReportVersionView } from '@xjournal/core';
import { connectorRepo, reportRepo } from '@xjournal/db';
import { stripCitations } from '@xjournal/reports';
import { z } from 'zod';
import { type ConnectorDeps, connectorConfigOf, messageOf } from './connectors';
import { asCaller, type Ctx } from './context';
import { notFound, parse, ServiceError } from './errors';
import { getReport } from './reports';

// Publishing (spec §3.7 / plan.md M3): a daily report's current text to the user's Confluence
// work log, through their Confluence connector account. Only the hub's own rows are
// overwritten; a row someone edited in Confluence is refused unless forced.

export const DESTINATION = 'confluence-worklog';

export const zPublish = z.object({
  versionId: z.string().min(1),
  /** The Confluence connector account to publish with (default: the one with a work log). */
  connectorAccountId: z.string().optional(),
  force: z.boolean().default(false),
  /** Publishing writes outside the hub: callers must say so (api.md §3.7). */
  confirm: z.literal(true),
});

export type PublishResult =
  | (PublishOutcome & { versionId: string; date: string })
  | { status: 'skipped'; reason: string }
  | { status: 'error'; message: string };

async function worklogAccount(ctx: Ctx, deps: Pick<ConnectorDeps, 'registry'>, id?: string) {
  return asCaller(ctx, async (tx) => {
    const accounts = await connectorRepo.listAccounts(tx);
    const match = accounts.find((a) => {
      if (id && a.id !== id) return false;
      return (
        a.source.startsWith('confluence:') && (a.config as { worklog?: unknown }).worklog != null
      );
    });
    if (!match) return null;
    const connector = deps.registry.get('confluence');
    const config = (connector?.parseConfig(connectorConfigOf(match.config)) ??
      match.config) as ConfluencePagesConfig;
    return { account: match, config };
  });
}

export async function publishReport(
  ctx: Ctx,
  deps: Pick<ConnectorDeps, 'registry' | 'secrets' | 'fetch'>,
  input: unknown,
): Promise<PublishResult> {
  const req = parse(zPublish, input);
  const version = await getReport(ctx, { versionId: req.versionId });
  if (version.kind !== 'daily') {
    throw new ServiceError(400, 'bad_request', 'Only daily reports go to the Confluence work log');
  }
  const found = await worklogAccount(ctx, deps, req.connectorAccountId);
  if (!found?.config.worklog) {
    throw notFound('No Confluence connector with a work log; set "worklog" in its config');
  }
  const { account, config } = found;
  const worklog = config.worklog as NonNullable<ConfluencePagesConfig['worklog']>;
  const token = account.secretRef ? await deps.secrets.get(account.secretRef) : null;
  if (!token)
    throw new ServiceError(
      400,
      'bad_request',
      'The Confluence token is missing; replace it in Settings',
    );
  const date = version.period.start;
  const last = await asCaller(ctx, (tx) =>
    reportRepo.lastExport(tx, ctx.actor.userId, DESTINATION, date),
  );

  const outcome = await publishWorklogDay(
    {
      baseUrl: config.baseUrl,
      spaceKey: worklog.space,
      token,
      ...(config.auth === 'basic' ? { user: config.login } : {}),
      rootPageId: worklog.rootPageId,
      ...(worklog.jiraServer && worklog.jiraServerId
        ? { jira: { server: worklog.jiraServer, serverId: worklog.jiraServerId } }
        : {}),
      ...(deps.fetch ? { fetch: deps.fetch } : {}),
    },
    {
      date,
      markdown: stripCitations(version.bodyMd),
      lastHash: last?.contentHash ?? null,
      force: req.force,
    },
  );
  if (outcome.status === 'published') {
    await asCaller(ctx, (tx) =>
      reportRepo.insertExport(tx, {
        id: newId(),
        workspaceId: ctx.actor.workspaceId,
        reportVersionId: version.versionId,
        destination: DESTINATION,
        target: date,
        externalUrl: outcome.url,
        contentHash: outcome.contentHash,
        createdBy: ctx.actor.userId,
      }),
    );
  }
  return { ...outcome, versionId: version.versionId, date };
}

/**
 * After a daily report is saved: publish it if a Confluence account has `worklog.mirrorDaily`.
 * Never throws; the outcome (including a refusal) goes back to whoever saved.
 */
export async function mirrorDaily(
  ctx: Ctx,
  deps: Pick<ConnectorDeps, 'registry' | 'secrets' | 'fetch'>,
  saved: ReportVersionView,
): Promise<PublishResult> {
  if (saved.kind !== 'daily') return { status: 'skipped', reason: 'not a daily report' };
  try {
    const found = await worklogAccount(ctx, deps);
    if (!found?.config.worklog?.mirrorDaily)
      return { status: 'skipped', reason: 'mirroring is off' };
    return await publishReport(ctx, deps, { versionId: saved.versionId, confirm: true });
  } catch (e) {
    return { status: 'error', message: messageOf(e) };
  }
}
