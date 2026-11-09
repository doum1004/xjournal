import {
  isTimeZone,
  type MemberRole,
  memberRoles,
  newId,
  type ProjectView,
  zProjectInput,
} from '@xjournal/core';
import { type ProjectRow, projectRepo, type Tx } from '@xjournal/db';
import { asCaller, type Ctx } from './context';
import { conflict, forbidden, parse, ServiceError } from './errors';

export const atLeast = (role: MemberRole | null | undefined, min: MemberRole) =>
  role != null && memberRoles.indexOf(role) >= memberRoles.indexOf(min);

export function toProjectView(p: ProjectRow, workspaceTimeZone: string): ProjectView {
  return {
    id: p.id,
    slug: p.slug,
    name: p.name,
    timeZone: p.timeZone ?? workspaceTimeZone,
    role: p.role ?? 'viewer',
    defaultNoteVisibility: p.defaultNoteVisibility,
  };
}

export async function workspaceTimeZone(tx: Tx): Promise<string> {
  const ws = await projectRepo.getWorkspace(tx);
  if (!ws) throw new ServiceError(409, 'not_initialized', 'No workspace for this user');
  return ws.timeZone;
}

/** `GET /projects` (api.md §3.2). */
export async function listProjects(ctx: Ctx): Promise<ProjectView[]> {
  return asCaller(ctx, async (tx) => {
    const tz = await workspaceTimeZone(tx);
    return (await projectRepo.listProjects(tx)).map((p) => toProjectView(p, tz));
  });
}

/** `POST /projects` (api.md §3.2): the workspace owner only; the caller becomes its owner. */
export async function createProject(ctx: Ctx, input: unknown): Promise<ProjectView> {
  const p = parse(zProjectInput, input);
  if (p.timeZone && !isTimeZone(p.timeZone)) {
    throw new ServiceError(400, 'bad_request', `Unknown time zone: ${p.timeZone}`);
  }
  return asCaller(ctx, async (tx) => {
    const tz = await workspaceTimeZone(tx);
    if (await projectRepo.slugTaken(tx, p.slug))
      throw conflict(`Project "${p.slug}" already exists`);
    const id = newId();
    try {
      await projectRepo.insertProject(tx, ctx.actor, { id, ...p });
    } catch (e) {
      if (isRlsViolation(e)) throw forbidden('Only the workspace owner can create projects');
      throw e;
    }
    const row = await projectRepo.findProject(tx, id);
    if (!row) throw new ServiceError(500, 'internal', 'Project not readable after create');
    return toProjectView(row, tz);
  });
}

/** True for Postgres "new row violates row-level security policy" (42501). */
export function isRlsViolation(e: unknown): boolean {
  for (let err: unknown = e; err; err = (err as { cause?: unknown }).cause) {
    const code = (err as { code?: string }).code;
    if (code === '42501') return true;
    if (String((err as Error).message ?? '').includes('row-level security')) return true;
  }
  return false;
}
