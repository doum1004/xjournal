import {
  contentHash,
  localDate,
  type NoteChannel,
  newId,
  noteTitleAndSummary,
  type Page,
  parseNoteHints,
  type RecordView,
  type RevisionView,
  type Visibility,
  zNoteEdit,
  zNoteInput,
  zPageQuery,
  zRouteInput,
  zSearchQuery,
} from '@xjournal/core';
import {
  type ProjectRow,
  projectRepo,
  type RecordRow,
  recordRepo,
  type Tx,
  workItemRepo,
} from '@xjournal/db';
import { asCaller, type Ctx } from './context';
import { forbidden, notFound, parse, ServiceError } from './errors';
import { atLeast, isRlsViolation, workspaceTimeZone } from './projects';

// Notes, records, Inbox and search (api.md §3.3; spec §3.4, §3.6).

/** `restricted` needs an audience picker, which arrives with shared projects (Phase 3). */
function checkVisibility(v: Visibility | undefined) {
  if (v === 'restricted') {
    throw new ServiceError(400, 'bad_request', '"restricted" visibility is not available yet');
  }
}

// ------------------------------------------------------------------------------------------
// Views
// ------------------------------------------------------------------------------------------

export async function toViews(tx: Tx, ctx: Ctx, rows: RecordRow[]): Promise<RecordView[]> {
  const ids = rows.map((r) => r.id);
  // Sequential on purpose: one transaction is one connection, which runs one query at a time
  // (node-postgres warns about overlapping queries, and pg@9 rejects them).
  const numbers = await recordRepo.revisionNumbers(
    tx,
    rows.map((r) => r.currentRevisionId),
  );
  const tags = await recordRepo.tagsFor(tx, ids);
  const names = await projectRepo.displayNames(tx, [...new Set(rows.map((r) => r.ownerUserId))]);
  const items = new Map<string, string[]>();
  const guesses = new Map<string, Record<string, number>>();
  for (const l of await workItemRepo.linksOf(tx, ids)) {
    items.set(l.recordId, [...(items.get(l.recordId) ?? []), l.workItemId]);
    if (l.origin === 'ai') {
      guesses.set(l.recordId, { ...guesses.get(l.recordId), [l.workItemId]: l.confidence ?? 0 });
    }
  }
  return rows.map((r) => ({
    id: r.id,
    revisionId: r.currentRevisionId,
    revisionNo: numbers.get(r.currentRevisionId) ?? 1,
    source: r.source,
    externalId: r.externalId,
    kind: r.kind,
    tier: r.tier,
    title: r.title,
    ...(r.summary ? { summary: r.summary } : {}),
    ...(r.url ? { url: r.url } : {}),
    eventTime: r.eventTime.toISOString(),
    applicableDate: r.applicableDate,
    ...(r.enteredAt ? { enteredAt: r.enteredAt.toISOString() } : {}),
    projectId: r.projectId,
    routingStatus: r.routingStatus,
    ...(r.noteKind ? { noteKind: r.noteKind } : {}),
    tags: tags.get(r.id) ?? [],
    owner: { id: r.ownerUserId, name: names.get(r.ownerUserId) ?? '' },
    isMine: r.ownerUserId === ctx.actor.userId,
    visibility: r.visibility,
    hidden: r.hiddenAt != null,
    workItemIds: (items.get(r.id) ?? []).sort(),
    ...(guesses.has(r.id) ? { suggestedWorkItems: guesses.get(r.id) } : {}),
  }));
}

async function toView(tx: Tx, ctx: Ctx, row: RecordRow): Promise<RecordView> {
  const [view] = await toViews(tx, ctx, [row]);
  if (!view) throw new ServiceError(500, 'internal', 'Could not build the record view');
  return view;
}

async function mustGet(tx: Tx, id: string): Promise<RecordRow> {
  const row = await recordRepo.getRecord(tx, id);
  if (!row) throw notFound('Record not found');
  return row;
}

// ------------------------------------------------------------------------------------------
// Notes
// ------------------------------------------------------------------------------------------

export interface AddNoteResult {
  note: RecordView;
  routed: boolean;
}

/**
 * `POST /notes`, `hub note "…"` (api.md §3.3). The raw text is stored as written, in
 * revision 1, and never changed (spec §3.6). Routing order in M1: inline hints, then an
 * explicit `projectId`, else the Inbox. Project rules and AI routing come in M2–M3.
 */
export async function addNote(
  ctx: Ctx,
  input: unknown,
  channel: NoteChannel,
  now: Date = new Date(),
): Promise<AddNoteResult> {
  const n = parse(zNoteInput, input);
  checkVisibility(n.visibility);
  return asCaller(ctx, async (tx) => {
    const wsTz = await workspaceTimeZone(tx);
    let parsed = parseNoteHints(n.text, localDate(now, wsTz));
    const { hints } = parsed;

    // Pick the project: a single `#slug` hint wins, then the explicit projectId.
    let project: ProjectRow | null = null;
    let routedBy: 'hint' | 'user' = 'user';
    const unresolved: string[] = [];
    if (hints.projects.length === 1) {
      const slug = hints.projects[0] as string;
      project = await projectRepo.findProjectBySlug(tx, slug);
      if (project) routedBy = 'hint';
      else unresolved.push(slug);
    } else if (hints.projects.length === 0 && n.projectId) {
      project = await projectRepo.findProject(tx, n.projectId);
      if (!project) throw notFound('Project not found');
    }
    // Without contributor rights the note still gets written, to the caller's Inbox.
    if (project && !atLeast(project.role, 'contributor')) project = null;

    const tz = project?.timeZone ?? wsTz;
    if (tz !== wsTz) parsed = parseNoteHints(n.text, localDate(now, tz));
    const today = localDate(now, tz);
    const noteKind = parsed.hints.kind ?? 'event';
    const applicableDate = noteKind === 'event' ? (parsed.hints.date ?? today) : today;
    const visibility = n.visibility ?? project?.defaultNoteVisibility ?? 'private';
    const { title, summary } = noteTitleAndSummary(parsed.clean, n.text);

    const id = newId();
    const revisionId = newId();
    const payload: Record<string, unknown> = { text: n.text, channel };
    if (hints.projects.length || hints.date || hints.kind || hints.tags.length) {
      payload.hints = {
        projects: hints.projects,
        ...(parsed.hints.date ? { date: parsed.hints.date } : {}),
        ...(hints.kind ? { kind: hints.kind } : {}),
        tags: hints.tags,
        ...(unresolved.length ? { unresolvedProjects: unresolved } : {}),
      };
    }
    await recordRepo.insertRecord(
      tx,
      {
        id,
        workspaceId: ctx.actor.workspaceId,
        source: 'note',
        externalId: id,
        kind: 'note',
        tier: 'manual',
        ownerUserId: ctx.actor.userId,
        isMine: true,
        eventTime: now,
        capturedAt: now,
        enteredAt: now,
        applicableDate,
        projectId: project?.id ?? null,
        routingStatus: project ? 'confirmed' : 'needs_review',
        routedBy,
        noteKind,
        visibility,
        title,
        ...(summary ? { summary } : {}),
      },
      {
        id: revisionId,
        kind: 'created',
        contentHash: contentHash({ title, summary, text: n.text }),
        title,
        ...(summary ? { summary } : {}),
        payload,
        changedBy: ctx.actor.userId,
      },
      parsed.hints.tags,
    );
    return { note: await toView(tx, ctx, await mustGet(tx, id)), routed: project != null };
  });
}

/** `PATCH /notes/{id}`: a new content revision. Earlier revisions stay as they were. */
export async function editNote(ctx: Ctx, id: string, input: unknown): Promise<RecordView> {
  const { text } = parse(zNoteEdit, input);
  return asCaller(ctx, async (tx) => {
    const current = await mustGet(tx, id);
    if (current.kind !== 'note') throw new ServiceError(400, 'bad_request', 'Not a note');
    if (current.ownerUserId !== ctx.actor.userId)
      throw forbidden('Only the author can edit a note');

    // Hints are applied when a note is written; on edit they only leave the title.
    const { clean } = parseNoteHints(text, current.applicableDate);
    const { title, summary } = noteTitleAndSummary(clean, text);
    const hash = contentHash({ title, summary, text });
    const rev = await recordRepo.getRevision(tx, current.currentRevisionId);
    if (rev?.contentHash === hash) return toView(tx, ctx, current);

    await recordRepo.appendRevision(
      tx,
      current,
      {
        id: newId(),
        kind: 'content',
        contentHash: hash,
        title,
        ...(summary ? { summary } : {}),
        payload: { text },
        changedBy: ctx.actor.userId,
      },
      { title, summary: summary ?? null },
    );
    return toView(tx, ctx, await mustGet(tx, id));
  });
}

/**
 * `POST /records/{id}/route` (api.md §3.3): change project, date, kind, visibility or tags.
 * A metadata revision records the change; the content is untouched (spec §3.6).
 */
export async function routeRecord(ctx: Ctx, id: string, input: unknown): Promise<RecordView> {
  const r = parse(zRouteInput, input);
  checkVisibility(r.visibility);
  return asCaller(ctx, async (tx) => {
    const current = await mustGet(tx, id);
    const isOwner = current.ownerUserId === ctx.actor.userId;
    const currentRole = current.projectId
      ? (await projectRepo.findProject(tx, current.projectId))?.role
      : null;
    if (!isOwner && !atLeast(currentRole, 'manager')) {
      throw forbidden('Only the owner or a project manager can route this record');
    }
    if (r.kind && current.kind !== 'note') {
      throw new ServiceError(400, 'bad_request', 'Only notes have a kind');
    }

    let projectId = current.projectId;
    if (r.projectId !== undefined) {
      projectId = r.projectId;
      if (projectId) {
        const target = await projectRepo.findProject(tx, projectId);
        if (!target) throw notFound('Project not found');
        if (!atLeast(target.role, isOwner ? 'contributor' : 'manager')) {
          throw forbidden('You need at least contributor rights in the target project');
        }
      }
    }

    const patch: recordRepo.RecordPatch = {};
    if (projectId !== current.projectId) patch.projectId = projectId;
    if (r.date && r.date !== current.applicableDate) patch.applicableDate = r.date;
    if (r.kind && r.kind !== current.noteKind) patch.noteKind = r.kind;
    if (r.visibility && r.visibility !== current.visibility) patch.visibility = r.visibility;
    const routing = {
      routingStatus: projectId ? ('confirmed' as const) : ('needs_review' as const),
      routedBy: 'user' as const,
      routingConfidence: null,
    };
    const needsConfirm = projectId != null && current.routingStatus !== 'confirmed';

    if (r.tags) {
      await recordRepo.replaceTags(tx, current.id, current.workspaceId, r.tags);
    }
    if (Object.keys(patch).length > 0 || needsConfirm) {
      // A metadata revision is a full snapshot: same content, new metadata.
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
          { ...patch, ...routing },
        );
      } catch (e) {
        if (isRlsViolation(e)) throw forbidden('Not allowed to route this record there');
        throw e;
      }
    }
    // Making a record invisible to yourself is possible for a manager; then it's gone.
    const after = await recordRepo.getRecord(tx, id);
    if (!after) throw notFound('Record not found');
    return toView(tx, ctx, after);
  });
}

// ------------------------------------------------------------------------------------------
// Reading
// ------------------------------------------------------------------------------------------

/** `GET /records/{id}`. Missing and invisible look the same: 404 (api.md §1). */
export async function getRecord(ctx: Ctx, id: string): Promise<RecordView> {
  return asCaller(ctx, async (tx) => toView(tx, ctx, await mustGet(tx, id)));
}

/** `GET /records/{id}/revisions`, oldest first. */
export async function listRevisions(ctx: Ctx, id: string): Promise<RevisionView[]> {
  return asCaller(ctx, async (tx) => {
    await mustGet(tx, id);
    const rows = await recordRepo.listRevisions(tx, id);
    return rows.map((r) => ({
      id: r.id,
      revisionNo: r.revisionNo,
      kind: r.kind,
      contentHash: r.contentHash,
      title: r.title,
      ...(r.summary ? { summary: r.summary } : {}),
      payload: r.payload as Record<string, unknown>,
      projectId: r.projectId,
      applicableDate: r.applicableDate,
      visibility: r.visibility,
      ...(r.noteKind ? { noteKind: r.noteKind } : {}),
      changedBy: r.changedBy,
      capturedAt: r.capturedAt.toISOString(),
    }));
  });
}

/** `GET /inbox`: the caller's unrouted or needs-review items, newest first. */
export async function listInbox(ctx: Ctx, query: unknown = {}): Promise<Page<RecordView>> {
  const q = parse(zPageQuery, query);
  return asCaller(ctx, async (tx) => {
    const rows = await recordRepo.listInbox(tx, ctx.actor.userId, {
      limit: q.limit + 1,
      ...(q.cursor ? { before: q.cursor } : {}),
    });
    const page = rows.slice(0, q.limit);
    const last = page.at(-1);
    return {
      items: await toViews(tx, ctx, page),
      nextCursor: rows.length > q.limit && last ? last.id : null,
    };
  });
}

/** `GET /search` (mode `text`; semantic search arrives in M5). */
export async function search(
  ctx: Ctx,
  query: unknown,
): Promise<Page<RecordView & { score: number }>> {
  const q = parse(zSearchQuery, query);
  const offset = q.cursor ? decodeOffset(q.cursor) : 0;
  return asCaller(ctx, async (tx) => {
    const hits = await recordRepo.searchRecords(tx, {
      q: q.q,
      ...(q.projectId ? { projectId: q.projectId } : {}),
      ...(q.from ? { from: q.from } : {}),
      ...(q.to ? { to: q.to } : {}),
      ...(q.kinds ? { kinds: q.kinds } : {}),
      limit: q.limit + 1,
      offset,
    });
    const page = hits.slice(0, q.limit);
    const views = await toViews(
      tx,
      ctx,
      page.map((h) => h.row),
    );
    return {
      items: views.map((v, i) => ({ ...v, score: page[i]?.score ?? 0 })),
      nextCursor: hits.length > q.limit ? encodeOffset(offset + q.limit) : null,
    };
  });
}

const encodeOffset = (n: number) => Buffer.from(`o:${n}`).toString('base64url');
function decodeOffset(cursor: string): number {
  const m = /^o:(\d+)$/.exec(Buffer.from(cursor, 'base64url').toString());
  if (!m) throw new ServiceError(400, 'bad_request', 'Invalid cursor');
  return Number(m[1]);
}
