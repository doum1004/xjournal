import { isTimeZone, type ProjectView, zVisibility } from '@xjournal/core';
import { connectorRepo, projectRepo } from '@xjournal/db';
import { connectorSecretRef } from '@xjournal/secrets';
import { z } from 'zod';
import {
  type ConnectorDeps,
  type ConnectorView,
  connectorConfigOf,
  HUB_CONFIG_KEYS,
  messageOf,
  toConnectorView,
} from './connectors';
import { asCaller, type Ctx } from './context';
import { forbidden, notFound, parse, ServiceError } from './errors';
import { atLeast, toProjectView, workspaceTimeZone } from './projects';

// Settings the web UI manages (plan.md M2): the workspace, projects, and connector accounts.

const zTimeZone = z.string().refine(isTimeZone, 'an IANA time zone, e.g. America/New_York');

// ------------------------------------------------------------------------------------------
// Workspace
// ------------------------------------------------------------------------------------------

export interface WorkspaceView {
  id: string;
  name: string;
  domain: string;
  timeZone: string;
  /** 1 = Monday … 7 = Sunday (ISO). */
  weekStart: number;
  isOwner: boolean;
}

export async function getWorkspace(ctx: Ctx): Promise<WorkspaceView> {
  return asCaller(ctx, async (tx) => {
    const ws = await projectRepo.getWorkspaceSettings(tx);
    if (!ws) throw new ServiceError(409, 'not_initialized', 'No workspace for this user');
    return {
      id: ws.id,
      name: ws.name,
      domain: ws.domain,
      timeZone: ws.timeZone,
      weekStart: ws.weekStart,
      isOwner: ws.ownerUserId === ctx.actor.userId,
    };
  });
}

export const zWorkspacePatch = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    timeZone: zTimeZone.optional(),
    weekStart: z.number().int().min(1).max(7).optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), 'nothing to change');

/** `PATCH /workspace`: the workspace owner only. */
export async function updateWorkspace(ctx: Ctx, input: unknown): Promise<WorkspaceView> {
  const patch = parse(zWorkspacePatch, input);
  const ok = await asCaller(ctx, (tx) =>
    projectRepo.updateWorkspace(tx, ctx.actor.workspaceId, {
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.timeZone !== undefined ? { timeZone: patch.timeZone } : {}),
      ...(patch.weekStart !== undefined ? { weekStart: patch.weekStart } : {}),
    }),
  );
  if (!ok) throw forbidden('Only the workspace owner can change its settings');
  return getWorkspace(ctx);
}

// ------------------------------------------------------------------------------------------
// Projects
// ------------------------------------------------------------------------------------------

export const zProjectPatch = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    /** `null` follows the workspace time zone. */
    timeZone: zTimeZone.nullable().optional(),
    defaultNoteVisibility: zVisibility.optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), 'nothing to change');

/** `PATCH /projects/{p}`: manager and up. Existing records keep their dates. */
export async function updateProject(ctx: Ctx, id: string, input: unknown): Promise<ProjectView> {
  const patch = parse(zProjectPatch, input);
  return asCaller(ctx, async (tx) => {
    const p = await projectRepo.findProject(tx, id);
    if (!p) throw notFound('Project not found');
    if (!atLeast(p.role, 'manager')) throw forbidden('You need manager rights in this project');
    await projectRepo.updateProject(tx, id, {
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.timeZone !== undefined ? { timeZone: patch.timeZone } : {}),
      ...(patch.defaultNoteVisibility
        ? { defaultNoteVisibility: patch.defaultNoteVisibility }
        : {}),
    });
    const row = await projectRepo.findProject(tx, id);
    if (!row) throw notFound('Project not found');
    return toProjectView(row, await workspaceTimeZone(tx));
  });
}

/** `POST /projects/{p}/archive`: the project owner. Its records and reports stay. */
export async function archiveProject(ctx: Ctx, id: string, now: Date = new Date()): Promise<void> {
  await asCaller(ctx, async (tx) => {
    const p = await projectRepo.findProject(tx, id);
    if (!p) throw notFound('Project not found');
    if (p.role !== 'owner') throw forbidden('Only the project owner can archive it');
    await projectRepo.updateProject(tx, id, { archivedAt: now });
  });
}

// ------------------------------------------------------------------------------------------
// Connector accounts
// ------------------------------------------------------------------------------------------

export const zConnectorPatch = z
  .object({
    displayName: z.string().trim().min(1).max(200).optional(),
    /** The connector's own config, replaced as a whole (hub keys like backfillFrom are kept). */
    config: z.record(z.string(), z.unknown()).optional(),
    projectIds: z.array(z.string()).optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), 'nothing to change');

/** `PATCH /connectors/{id}`. The source (e.g. the GitHub host) can't change. */
export async function updateConnector(
  ctx: Ctx,
  deps: Pick<ConnectorDeps, 'registry'>,
  id: string,
  input: unknown,
): Promise<ConnectorView> {
  const patch = parse(zConnectorPatch, input);
  return asCaller(ctx, async (tx) => {
    const a = await connectorRepo.getAccount(tx, id);
    if (!a || a.disconnectedAt) throw notFound('Connector not found');
    const update: Parameters<typeof connectorRepo.updateAccount>[2] = {};
    if (patch.displayName) update.displayName = patch.displayName;

    if (patch.config) {
      const kind = a.source.split(':', 1)[0] ?? '';
      const connector = deps.registry.get(kind);
      if (!connector) throw new ServiceError(400, 'bad_request', `No connector for ${a.source}`);
      let parsed: unknown;
      try {
        parsed = connector.parseConfig(connectorConfigOf(patch.config));
      } catch (e) {
        throw new ServiceError(400, 'bad_request', `Invalid ${kind} config: ${messageOf(e)}`);
      }
      if (connector.sourceKey(parsed) !== a.source) {
        throw new ServiceError(
          400,
          'bad_request',
          'This would change the source (e.g. the host); connect a new account instead',
        );
      }
      const hub = Object.fromEntries(
        HUB_CONFIG_KEYS.filter((k) => k in (a.config as object)).map((k) => [
          k,
          (a.config as Record<string, unknown>)[k],
        ]),
      );
      update.config = { ...(parsed as Record<string, unknown>), ...hub };
    }
    if (Object.keys(update).length) await connectorRepo.updateAccount(tx, id, update);

    if (patch.projectIds) {
      const current = (await connectorRepo.projectSourcesFor(tx, id)).map((p) => p.projectId);
      for (const pid of patch.projectIds.filter((p) => !current.includes(p))) {
        const p = await projectRepo.findProject(tx, pid);
        if (!p) throw notFound(`Project not found: ${pid}`);
        if (!atLeast(p.role, 'contributor')) {
          throw forbidden('You need at least contributor rights in that project');
        }
        await connectorRepo.attachProject(tx, {
          projectId: pid,
          connectorAccountId: id,
          workspaceId: ctx.actor.workspaceId,
          addedBy: ctx.actor.userId,
        });
      }
      for (const pid of current.filter((p) => !patch.projectIds?.includes(p))) {
        await connectorRepo.detachProject(tx, id, pid);
      }
    }

    const row = await connectorRepo.getAccount(tx, id);
    if (!row) throw notFound('Connector not found');
    const ps = await connectorRepo.projectSourcesFor(tx, id);
    return toConnectorView(
      row,
      ps.map((p) => p.projectId),
      await connectorRepo.syncStatesFor(tx, id),
    );
  });
}

/** `PUT /connectors/{id}/secret`: store a new credential (e.g. a rotated token). */
export async function replaceConnectorSecret(
  ctx: Ctx,
  deps: Pick<ConnectorDeps, 'secrets'>,
  id: string,
  input: unknown,
): Promise<void> {
  const { secret } = parse(z.object({ secret: z.string().trim().min(1) }), input);
  const a = await asCaller(ctx, (tx) => connectorRepo.getAccount(tx, id));
  if (!a || a.disconnectedAt) throw notFound('Connector not found');
  const ref = a.secretRef ?? connectorSecretRef(a.id);
  await deps.secrets.set(ref, secret);
  await asCaller(ctx, (tx) =>
    connectorRepo.updateAccount(tx, id, { secretRef: ref, status: 'ok' }),
  );
}
