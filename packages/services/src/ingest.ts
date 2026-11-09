import {
  contentHash,
  type InputTier,
  localDate,
  newId,
  type RecordInput,
  zRecordInput,
} from '@xjournal/core';
import { projectRepo, recordRepo } from '@xjournal/db';
import { asCaller, type Ctx } from './context';
import { conflict, forbidden, notFound, ServiceError } from './errors';
import { atLeast, workspaceTimeZone } from './projects';

// Ingest through the record contract (schema.md §1, api.md §3.3 `/ingest`). File imports use
// it now; webhooks, the agent bridge and connectors use it from M2–M3.

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

const payloadOf = (r: RecordInput) => ({ ...(r.payload ?? {}), actor: r.actor });
const hashOf = (r: RecordInput) =>
  contentHash({ title: r.title, summary: r.summary, url: r.url, payload: payloadOf(r) });

/**
 * Create or update records, idempotently: `(source, externalId)` identifies a record; the
 * same content hash is a no-op and a different one adds a content revision (schema.md §1).
 * One transaction for the whole batch.
 */
export async function ingestRecords(
  ctx: Ctx,
  req: IngestRequest,
  now: Date = new Date(),
): Promise<IngestResult> {
  if (!SOURCE_RE.test(req.source)) {
    throw new ServiceError(400, 'bad_request', `Invalid source key: ${req.source}`);
  }
  const result: IngestResult = { created: 0, updated: 0, unchanged: 0, rejected: [] };

  // Validate each record on its own, so one bad item doesn't sink the batch.
  const valid = new Map<string, RecordInput>();
  for (const raw of req.records) {
    const externalId =
      raw && typeof raw === 'object' && 'externalId' in raw ? String(raw.externalId) : '';
    const parsed = zRecordInput.safeParse(raw);
    if (!parsed.success) {
      const message = parsed.error.issues
        .map((i) => `${i.path.join('.') || 'record'}: ${i.message}`)
        .join('; ');
      result.rejected.push({ externalId, code: 'bad_request', message });
    } else if (NEEDS_URL.includes(req.tier) && !parsed.data.url) {
      result.rejected.push({ externalId, code: 'bad_request', message: 'url is required' });
    } else if (valid.has(parsed.data.externalId)) {
      result.rejected.push({ externalId, code: 'conflict', message: 'duplicate in this batch' });
    } else {
      valid.set(parsed.data.externalId, parsed.data);
    }
  }
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
    const tz = project?.timeZone ?? wsTz;
    const existing = await recordRepo.findBySourceKeys(tx, req.source, [...valid.keys()]);

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
      const id = newId();
      await recordRepo.insertRecord(
        tx,
        {
          id,
          workspaceId: ctx.actor.workspaceId,
          source: req.source,
          externalId: r.externalId,
          kind: r.kind,
          tier: req.tier,
          ownerUserId: ctx.actor.userId,
          // Identity mapping (`identities`) arrives with the connectors in M2.
          isMine: true,
          eventTime,
          capturedAt: now,
          applicableDate: r.applicableDate ?? localDate(eventTime, tz),
          projectId: project?.id ?? null,
          routingStatus: project ? 'confirmed' : 'needs_review',
          routedBy: 'user',
          visibility: project?.defaultNoteVisibility ?? 'private',
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
    return result;
  }).catch((e: unknown) => {
    // A key that exists but isn't visible to the caller (someone else's private record).
    if ((e as { code?: string })?.code === '23505' || /duplicate key/.test(String(e))) {
      throw conflict('A record with one of these keys already exists');
    }
    throw e;
  });
}
