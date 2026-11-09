import {
  contentHash,
  firstMatch,
  newId,
  type RuleMatch,
  ruleMatches,
  zRuleMatch,
} from '@xjournal/core';
import { projectRepo, type RuleRow, recordRepo, ruleRepo, type Tx } from '@xjournal/db';
import { z } from 'zod';
import { asCaller, type Ctx } from './context';
import { conflict, forbidden, notFound, parse, ServiceError } from './errors';
import { atLeast, isRlsViolation } from './projects';

// Project assignment rules (spec §8.4, api.md §3.8): ordered conditions that file records
// into projects. Connectors apply them to new records; the Inbox can be re-run through them.
// Each change bumps the rule's version (`If-Match` on update).

export interface RuleView {
  id: string;
  projectId: string;
  priority: number;
  match: RuleMatch;
  version: number;
  active: boolean;
  createdAt: string;
}

const toView = (r: RuleRow): RuleView => ({
  id: r.id,
  projectId: r.projectId,
  priority: r.priority,
  match: r.match as RuleMatch,
  version: r.version,
  active: r.active,
  createdAt: r.createdAt.toISOString(),
});

async function mustManage(tx: Tx, ctx: Ctx, projectId: string) {
  const p = await projectRepo.findProject(tx, projectId);
  if (!p) throw notFound('Project not found');
  const ws = await projectRepo.getWorkspaceSettings(tx);
  if (!atLeast(p.role, 'manager') && ws?.ownerUserId !== ctx.actor.userId) {
    throw forbidden('You need manager rights in this project');
  }
  return p;
}

export async function listRules(ctx: Ctx, opts: { includeInactive?: boolean } = {}) {
  return asCaller(ctx, async (tx) => (await ruleRepo.listRules(tx, opts)).map(toView));
}

export const zRuleInput = z.object({
  projectId: z.string().min(1),
  /** Lower runs first. Default: after every existing rule. */
  priority: z.number().int().min(0).max(1_000_000).optional(),
  match: zRuleMatch,
});

export async function createRule(ctx: Ctx, input: unknown): Promise<RuleView> {
  const req = parse(zRuleInput, input);
  return asCaller(ctx, async (tx) => {
    await mustManage(tx, ctx, req.projectId);
    const existing = await ruleRepo.listRules(tx);
    const priority = req.priority ?? (existing.at(-1)?.priority ?? 0) + 10;
    const id = newId();
    await ruleRepo.insertRule(tx, {
      id,
      workspaceId: ctx.actor.workspaceId,
      projectId: req.projectId,
      priority,
      match: req.match,
      version: 1,
      active: true,
      createdBy: ctx.actor.userId,
    });
    const row = await ruleRepo.getRule(tx, id);
    if (!row) throw new ServiceError(500, 'internal', 'Rule not readable after create');
    return toView(row);
  });
}

export const zRulePatch = z
  .object({
    projectId: z.string().min(1).optional(),
    priority: z.number().int().min(0).max(1_000_000).optional(),
    match: zRuleMatch.optional(),
    active: z.boolean().optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), 'nothing to change');

/** `PUT /rules/{id}` with `If-Match: <version>`; a stale version is a 412. */
export async function updateRule(
  ctx: Ctx,
  id: string,
  ifMatch: number | null,
  input: unknown,
): Promise<RuleView> {
  const patch = parse(zRulePatch, input);
  return asCaller(ctx, async (tx) => {
    const current = await ruleRepo.getRule(tx, id);
    if (!current) throw notFound('Rule not found');
    await mustManage(tx, ctx, current.projectId);
    if (patch.projectId && patch.projectId !== current.projectId) {
      await mustManage(tx, ctx, patch.projectId);
    }
    const version = ifMatch ?? current.version;
    if (version !== current.version) {
      throw new ServiceError(412, 'conflict', `The rule changed (now version ${current.version})`);
    }
    const ok = await ruleRepo.updateRule(tx, id, version, {
      ...(patch.projectId ? { projectId: patch.projectId } : {}),
      ...(patch.priority !== undefined ? { priority: patch.priority } : {}),
      ...(patch.match ? { match: patch.match } : {}),
      ...(patch.active !== undefined ? { active: patch.active } : {}),
    });
    if (!ok) throw conflict('The rule changed while saving; reload it');
    const row = await ruleRepo.getRule(tx, id);
    if (!row) throw notFound('Rule not found');
    return toView(row);
  });
}

export const deactivateRule = (ctx: Ctx, id: string, ifMatch: number | null = null) =>
  updateRule(ctx, id, ifMatch, { active: false });

export interface RulePreview {
  /** Inbox records the match would file into the rule's project. */
  matches: { id: string; title: string; source: string; applicableDate: string }[];
  total: number;
}

/** `POST /rules/preview` `{match}`: which of your Inbox records it would move. */
export async function previewRule(ctx: Ctx, input: unknown): Promise<RulePreview> {
  const { match } = parse(z.object({ match: zRuleMatch }), input);
  return asCaller(ctx, async (tx) => {
    const inbox = await ruleRepo.inboxWithPayload(tx, ctx.actor.userId);
    const hits = inbox.filter((r) =>
      ruleMatches(match, { ...r, payload: r.payload as Record<string, unknown> }),
    );
    return {
      matches: hits.slice(0, 100).map((r) => ({
        id: r.id,
        title: r.title,
        source: r.source,
        applicableDate: r.applicableDate,
      })),
      total: hits.length,
    };
  });
}

/**
 * `POST /rules/apply`: file every Inbox record that matches an active rule into that rule's
 * project (a metadata revision, `routed_by = 'rule'`). Their bundles go stale through the
 * records trigger.
 */
export async function applyRules(
  ctx: Ctx,
): Promise<{ routed: number; byProject: Record<string, number> }> {
  return asCaller(ctx, async (tx) => {
    const rules = (await ruleRepo.listRules(tx)).map((r) => ({
      ...r,
      match: r.match as RuleMatch,
    }));
    const usable = [];
    for (const r of rules) {
      const p = await projectRepo.findProject(tx, r.projectId);
      if (p && !p.archivedAt && atLeast(p.role, 'contributor')) usable.push(r);
    }
    const byProject: Record<string, number> = {};
    let routed = 0;
    for (const item of await ruleRepo.inboxWithPayload(tx, ctx.actor.userId)) {
      const rule = firstMatch(usable, {
        ...item,
        payload: item.payload as Record<string, unknown>,
      });
      if (!rule) continue;
      const current = await recordRepo.getRecord(tx, item.id);
      if (!current) continue;
      const rev = await recordRepo.getRevision(tx, current.currentRevisionId);
      try {
        await recordRepo.appendRevision(
          tx,
          current,
          {
            id: newId(),
            kind: 'metadata',
            contentHash: rev?.contentHash ?? contentHash({ title: current.title }),
            title: current.title,
            ...(current.summary ? { summary: current.summary } : {}),
            payload: (rev?.payload as Record<string, unknown>) ?? {},
            changedBy: ctx.actor.userId,
          },
          {
            projectId: rule.projectId,
            routingStatus: 'auto',
            routedBy: 'rule',
            routingConfidence: null,
          },
        );
      } catch (e) {
        if (isRlsViolation(e)) continue;
        throw e;
      }
      routed++;
      byProject[rule.projectId] = (byProject[rule.projectId] ?? 0) + 1;
    }
    return { routed, byProject };
  });
}

/** Rules a connector sync can file into: active, in projects where the caller contributes. */
export async function routingRules(tx: Tx) {
  const out: {
    priority: number;
    match: RuleMatch;
    project: {
      id: string;
      timeZone: string | null;
      visibility: 'project' | 'private' | 'restricted';
    };
  }[] = [];
  for (const r of await ruleRepo.listRules(tx)) {
    const p = await projectRepo.findProject(tx, r.projectId);
    if (!p || p.archivedAt || !atLeast(p.role, 'contributor')) continue;
    out.push({
      priority: r.priority,
      match: r.match as RuleMatch,
      project: { id: p.id, timeZone: p.timeZone, visibility: p.defaultNoteVisibility },
    });
  }
  return out;
}
