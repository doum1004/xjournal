import {
  contentHash,
  type InputTier,
  localDate,
  newId,
  type RecordInput,
  type RoutedBy,
  type RoutingStatus,
  type Visibility,
  zRecordInput,
} from '@xjournal/core';
import { projectRepo, recordRepo, type Tx } from '@xjournal/db';
import { asCaller, type Ctx } from './context';
import { conflict, forbidden, isUniqueViolation, notFound, ServiceError } from './errors';
import { atLeast, workspaceTimeZone } from './projects';

// Ingest through the record contract (schema.md §1, api.md §3.3 `/ingest`). File imports and
// the connector sync runner (sync.ts) use it; webhooks and the agent bridge from M3.

export interface IngestRequest {
  source: string;
  tier: Exclude<InputTier, 'manual'>;
  /** File into this project; `null` or absent sends new records to the Inbox. */
  projectId?: string | null;
  records: unknown[];
}

export interface IngestResult {
  created: number;
  updated: number;
  unchanged: number;
  rejected: { externalId: string; code: string; message: string }[];
}

/** Tiers that must link back to the item in its source (spec §8.8). */
const NEEDS_URL: InputTier[] = ['webhook', 'email', 'agent'];
const SOURCE_RE = /^[a-z][a-z0-9_-]*(:[^\s]+)?$/;

export const emptyResult = (): IngestResult => ({
  created: 0,
  updated: 0,
  unchanged: 0,
  rejected: [],
});

export function assertSourceKey(source: string) {
  if (!SOURCE_RE.test(source)) {
    throw new ServiceError(400, 'bad_request', `Invalid source key: ${source}`);
  }
}

const payloadOf = (r: RecordInput) => ({ ...(r.payload ?? {}), actor: r.actor });
const hashOf = (r: RecordInput) =>
  contentHash({ title: r.title, summary: r.summary, url: r.url, payload: payloadOf(r) });

/**
 * Validate each record on its own, so one bad item doesn't sink the batch. Valid records
 * come back keyed by external ID; the rest are added to `result.rejected`.
 */
export function validateRecords(
  raw: unknown[],
  tier: InputTier,
  result: IngestResult,
): Map<string, RecordInput> {
  const valid = new Map<string, RecordInput>();
  for (const item of raw) {
    const externalId =
      item && typeof item === 'object' && 'externalId' in item ? String(item.externalId) : '';
    const parsed = zRecordInput.safeParse(item);
    if (!parsed.success) {
      const message = parsed.error.issues
        .map((i) => `${i.path.join('.') || 'record'}: ${i.message}`)
        .join('; ');
      result.rejected.push({ externalId, code: 'bad_request', message });
    } else if (NEEDS_URL.includes(tier) && !parsed.data.url) {
      result.rejected.push({ externalId, code: 'bad_request', message: 'url is required' });
    } else if (valid.has(parsed.data.externalId)) {
      result.rejected.push({ externalId, code: 'conflict', message: 'duplicate in this batch' });
    } else {
      valid.set(parsed.data.externalId, parsed.data);
    }
  }
  return valid;
}

/** Where new records go and how they're marked. Existing records keep their routing. */
export interface WriteTarget {
  source: string;
  tier: Exclude<InputTier, 'manual'>;
  connectorAccountId?: string;
  project: { id: string; visibility: Visibility } | null;
  routingStatus: RoutingStatus;
  routedBy: RoutedBy;
  /** Time zone for applicable dates when a record has none. */
  timeZone: string;
  /** Is this source actor the caller? Without it every record counts as the caller's. */
  whoIs?: (actor: string) => { isMine: boolean; identityId?: string };
}

/**
 * Create or update records, idempotently, inside the caller's transaction: `(source,
 * externalId)` identifies a record; the same content hash is a no-op and a different one
 * adds a content revision (schema.md §1).
 */
export async function writeRecords(
  tx: Tx,
  ctx: Ctx,
  valid: Map<string, RecordInput>,
  target: WriteTarget,
  result: IngestResult,
  now: Date,
): Promise<void> {
  if (valid.size === 0) return;
  const existing = await recordRepo.findBySourceKeys(tx, target.source, [...valid.keys()]);

  for (const r of valid.values()) {
    const hash = hashOf(r);
    const current = existing.get(r.externalId);
    if (current) {
      if (current.ownerUserId !== ctx.actor.userId) {
        result.rejected.push({
          externalId: r.externalId,
          code: 'conflict',
          message: 'owned by someone else',
        });
        continue;
      }
      const rev = await recordRepo.getRevision(tx, current.currentRevisionId);
      if (rev?.contentHash === hash) {
        result.unchanged++;
        continue;
      }
      await recordRepo.appendRevision(
        tx,
        current,
        {
          id: newId(),
          kind: 'content',
          contentHash: hash,
          title: r.title,
          ...(r.summary ? { summary: r.summary } : {}),
          payload: payloadOf(r),
          changedBy: ctx.actor.userId,
        },
        { title: r.title, summary: r.summary ?? null, url: r.url ?? null },
      );
      result.updated++;
      continue;
    }

    const eventTime = new Date(r.eventTime);
    const who = target.whoIs?.(r.actor) ?? { isMine: true };
    await recordRepo.insertRecord(
      tx,
      {
        id: newId(),
        workspaceId: ctx.actor.workspaceId,
        source: target.source,
        externalId: r.externalId,
        kind: r.kind,
        tier: target.tier,
        ...(target.connectorAccountId ? { connectorAccountId: target.connectorAccountId } : {}),
        ownerUserId: ctx.actor.userId,
        ...(who.identityId ? { actorIdentityId: who.identityId } : {}),
        isMine: who.isMine,
        eventTime,
        capturedAt: now,
        applicableDate: r.applicableDate ?? localDate(eventTime, target.timeZone),
        projectId: target.project?.id ?? null,
        routingStatus: target.routingStatus,
        routedBy: target.routedBy,
        visibility: target.project?.visibility ?? 'private',
        title: r.title,
        ...(r.url ? { url: r.url } : {}),
        ...(r.summary ? { summary: r.summary } : {}),
      },
      {
        id: newId(),
        kind: 'created',
        contentHash: hash,
        title: r.title,
        ...(r.summary ? { summary: r.summary } : {}),
        payload: payloadOf(r),
        changedBy: ctx.actor.userId,
      },
    );
    result.created++;
  }
}

/** A key that exists but isn't visible to the caller (someone else's private record). */
export function mapDuplicateKey(e: unknown): never {
  if (isUniqueViolation(e)) {
    throw conflict('A record with one of these keys already exists');
  }
  throw e;
}

/** `POST /ingest`: one transaction for the whole batch. */
export async function ingestRecords(
  ctx: Ctx,
  req: IngestRequest,
  now: Date = new Date(),
): Promise<IngestResult> {
  assertSourceKey(req.source);
  const result = emptyResult();
  const valid = validateRecords(req.records, req.tier, result);
  if (valid.size === 0) return result;

  return asCaller(ctx, async (tx) => {
    const wsTz = await workspaceTimeZone(tx);
    let project: Awaited<ReturnType<typeof projectRepo.findProject>> = null;
    if (req.projectId) {
      project = await projectRepo.findProject(tx, req.projectId);
      if (!project) throw notFound('Project not found');
      if (!atLeast(project.role, 'contributor')) {
        throw forbidden('You need at least contributor rights in this project');
      }
    }
    await writeRecords(
      tx,
      ctx,
      valid,
      {
        source: req.source,
        tier: req.tier,
        project: project ? { id: project.id, visibility: project.defaultNoteVisibility } : null,
        routingStatus: project ? 'confirmed' : 'needs_review',
        routedBy: 'user',
        timeZone: project?.timeZone ?? wsTz,
      },
      result,
      now,
    );
    return result;
  }).catch(mapDuplicateKey);
}
