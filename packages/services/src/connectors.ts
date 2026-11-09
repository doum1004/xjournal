import { type ConnectorRegistry, kindOfSource, type SyncLog } from '@xjournal/connectors';
import { newId, zIsoDate, zVisibility } from '@xjournal/core';
import {
  type ConnectorAccountRow,
  connectorRepo,
  type IdentityRow,
  projectRepo,
  type SyncStateRow,
} from '@xjournal/db';
import { connectorSecretRef, type SecretStore } from '@xjournal/secrets';
import { z } from 'zod';
import { asCaller, type Ctx } from './context';
import { conflict, forbidden, isUniqueViolation, notFound, parse, ServiceError } from './errors';
import { atLeast } from './projects';

// Connector accounts and identities (spec §8.1–8.3, §8.7). Credentials go to the secret
// store and are never returned; the database keeps only a pointer.

export interface ConnectorDeps {
  registry: ConnectorRegistry;
  secrets: SecretStore;
  fetch?: typeof fetch;
  log?: SyncLog;
}

export const zConnectorInput = z.object({
  kind: z.string().min(1),
  displayName: z.string().trim().min(1).max(200).optional(),
  /** The connector's own config (hosts, owner and noise filters). */
  config: z.record(z.string(), z.unknown()).default({}),
  /** A personal access token or similar; omitted for auth type 'none'. */
  secret: z.string().min(1).optional(),
  /** Projects this account feeds (by ID). With exactly one, records are filed there. */
  projectIds: z.array(z.string()).default([]),
  defaultVisibility: zVisibility.optional(),
  /** How far back the first sync reaches (YYYY-MM-DD). */
  backfillFrom: zIsoDate.optional(),
});
export type ConnectorInput = z.input<typeof zConnectorInput>;

export interface StreamStateView {
  stream: string;
  lastSuccessAt: string | null;
  lastAttemptAt: string | null;
  lastError: string | null;
  historyFloor: string | null;
}

export interface ConnectorView {
  id: string;
  kind: string;
  source: string;
  displayName: string;
  authType: string;
  hasSecret: boolean;
  status: string;
  config: Record<string, unknown>;
  projectIds: string[];
  streams: StreamStateView[];
  createdAt: string;
  disconnectedAt: string | null;
}

const iso = (d: Date | null) => (d ? d.toISOString() : null);

export function toConnectorView(
  a: ConnectorAccountRow,
  projectIds: string[],
  states: SyncStateRow[],
): ConnectorView {
  return {
    id: a.id,
    kind: kindOfSource(a.source),
    source: a.source,
    displayName: a.displayName,
    authType: a.authType,
    hasSecret: a.secretRef != null,
    status: a.status,
    config: a.config as Record<string, unknown>,
    projectIds,
    streams: states.map((s) => ({
      stream: s.stream,
      lastSuccessAt: iso(s.lastSuccessAt),
      lastAttemptAt: iso(s.lastAttemptAt),
      lastError: s.lastError,
      historyFloor: iso(s.historyFloor),
    })),
    createdAt: a.createdAt.toISOString(),
    disconnectedAt: iso(a.disconnectedAt),
  };
}

/** Hub-level keys kept in `connector_accounts.config` next to the connector's own. */
export const HUB_CONFIG_KEYS = ['backfillFrom'] as const;
export function connectorConfigOf(config: unknown): Record<string, unknown> {
  const out = { ...((config ?? {}) as Record<string, unknown>) };
  for (const k of HUB_CONFIG_KEYS) delete out[k];
  return out;
}

/** Connect an account: validate its config, store the credential, attach projects. */
export async function addConnector(
  ctx: Ctx,
  deps: ConnectorDeps,
  input: unknown,
): Promise<ConnectorView> {
  const req = parse(zConnectorInput, input);
  const connector = deps.registry.get(req.kind);
  if (!connector) {
    const known = deps.registry
      .list()
      .map((d) => d.kind)
      .join(', ');
    throw new ServiceError(400, 'bad_request', `Unknown connector "${req.kind}" (known: ${known})`);
  }
  const desc = connector.describe();
  let parsedConfig: unknown;
  try {
    parsedConfig = connector.parseConfig(req.config);
  } catch (e) {
    throw new ServiceError(400, 'bad_request', `Invalid ${req.kind} config: ${messageOf(e)}`);
  }
  const authType = req.secret ? (desc.authTypes.find((t) => t !== 'none') ?? 'pat') : 'none';
  if (!desc.authTypes.includes(authType)) {
    throw new ServiceError(400, 'bad_request', `${desc.displayName} needs a credential`);
  }

  const id = newId();
  const secretRef = req.secret ? connectorSecretRef(id) : null;
  if (secretRef && req.secret) await deps.secrets.set(secretRef, req.secret);
  try {
    return await asCaller(ctx, async (tx) => {
      for (const pid of req.projectIds) {
        const p = await projectRepo.findProject(tx, pid);
        if (!p) throw notFound(`Project not found: ${pid}`);
        if (!atLeast(p.role, 'contributor')) {
          throw forbidden('You need at least contributor rights in that project');
        }
      }
      await connectorRepo.insertAccount(tx, {
        id,
        workspaceId: ctx.actor.workspaceId,
        ownerUserId: ctx.actor.userId,
        source: connector.sourceKey(parsedConfig),
        displayName: req.displayName ?? desc.displayName,
        authType,
        secretRef,
        config: {
          ...(parsedConfig as Record<string, unknown>),
          ...(req.backfillFrom ? { backfillFrom: req.backfillFrom } : {}),
        },
      });
      for (const pid of req.projectIds) {
        await connectorRepo.attachProject(tx, {
          projectId: pid,
          connectorAccountId: id,
          workspaceId: ctx.actor.workspaceId,
          addedBy: ctx.actor.userId,
          ...(req.defaultVisibility ? { defaultVisibility: req.defaultVisibility } : {}),
        });
      }
      const row = await connectorRepo.getAccount(tx, id);
      if (!row) throw new Error('connector account vanished after insert');
      return toConnectorView(row, req.projectIds, []);
    });
  } catch (e) {
    // Don't leave a credential behind for an account that doesn't exist.
    if (secretRef) await deps.secrets.delete(secretRef);
    throw e;
  }
}

export async function listConnectors(
  ctx: Ctx,
  opts: { includeDisconnected?: boolean } = {},
): Promise<ConnectorView[]> {
  return asCaller(ctx, async (tx) => {
    const accounts = await connectorRepo.listAccounts(tx, opts);
    const out: ConnectorView[] = [];
    for (const a of accounts) {
      const ps = await connectorRepo.projectSourcesFor(tx, a.id);
      const states = await connectorRepo.syncStatesFor(tx, a.id);
      out.push(
        toConnectorView(
          a,
          ps.map((p) => p.projectId),
          states,
        ),
      );
    }
    return out;
  });
}

/**
 * Disconnect an account: delete its credential and stop syncing. Its records stay, since
 * reports cite them (spec §8.6 retention is a separate, explicit action).
 */
export async function removeConnector(
  ctx: Ctx,
  deps: Pick<ConnectorDeps, 'secrets'>,
  id: string,
  now: Date = new Date(),
): Promise<void> {
  const ref = await asCaller(ctx, async (tx) => {
    const a = await connectorRepo.getAccount(tx, id);
    if (!a || a.disconnectedAt) throw notFound('Connector not found');
    await connectorRepo.updateAccount(tx, id, {
      disconnectedAt: now,
      status: 'disabled',
      secretRef: null,
    });
    return a.secretRef;
  });
  if (ref) await deps.secrets.delete(ref);
}

// ------------------------------------------------------------------------------------------
// Identities: "is this mine?" (spec §8.3)
// ------------------------------------------------------------------------------------------

export const zIdentityInput = z.object({
  source: z.string().regex(/^[a-z][a-z0-9_-]*(:[^\s]+)?$/, 'a source key, e.g. github:github.com'),
  accountKey: z.string().trim().min(1).max(200),
  /** Commit author names and emails that also mean this account. */
  aliases: z.array(z.string().trim().min(1).max(200)).default([]),
});

export interface IdentityView {
  id: string;
  source: string;
  accountKey: string;
  aliases: string[];
}

const toIdentityView = (i: IdentityRow): IdentityView => ({
  id: i.id,
  source: i.source,
  accountKey: i.accountKey,
  aliases: i.aliases,
});

export async function addIdentity(ctx: Ctx, input: unknown): Promise<IdentityView> {
  const req = parse(zIdentityInput, input);
  const row = {
    id: newId(),
    workspaceId: ctx.actor.workspaceId,
    userId: ctx.actor.userId,
    source: req.source,
    accountKey: req.accountKey,
    aliases: req.aliases,
  };
  await asCaller(ctx, (tx) => connectorRepo.insertIdentity(tx, row)).catch((e: unknown) => {
    if (isUniqueViolation(e)) {
      throw conflict(`${req.source} ${req.accountKey} is already mapped`);
    }
    throw e;
  });
  return toIdentityView(row);
}

export async function listIdentities(ctx: Ctx, source?: string): Promise<IdentityView[]> {
  return asCaller(ctx, async (tx) =>
    (await connectorRepo.listIdentities(tx, source)).map(toIdentityView),
  );
}

export async function removeIdentity(ctx: Ctx, id: string): Promise<void> {
  const gone = await asCaller(ctx, (tx) => connectorRepo.deleteIdentity(tx, id));
  if (!gone) throw notFound('Identity not found');
}

/**
 * Resolve a source actor (login, username, author name or email) to one of the caller's
 * identities, case-insensitively. Anything unmatched is someone else.
 */
export function identityResolver(ids: IdentityRow[]) {
  const byKey = new Map<string, string>();
  for (const i of ids) {
    for (const k of [i.accountKey, ...i.aliases]) byKey.set(k.toLowerCase(), i.id);
  }
  return (actor: string) => {
    const identityId = byKey.get(actor.toLowerCase());
    return identityId ? { isMine: true, identityId } : { isMine: false };
  };
}

export const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));
