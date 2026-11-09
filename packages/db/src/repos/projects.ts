import type { MemberRole, Visibility } from '@xjournal/core';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import type { Actor, Tx } from '../actor';
import { projectMembers, projects, users, workspaces } from '../schema';

// Projects and the caller's place in them. Every function runs inside `withActor`, so RLS
// limits what it sees (schema.md §9).

export interface ProjectRow {
  id: string;
  slug: string;
  name: string;
  timeZone: string | null;
  defaultNoteVisibility: Visibility;
  archivedAt: Date | null;
  role: MemberRole | null;
}

const projectColumns = {
  id: projects.id,
  slug: projects.slug,
  name: projects.name,
  timeZone: projects.timeZone,
  defaultNoteVisibility: projects.defaultNoteVisibility,
  archivedAt: projects.archivedAt,
  role: sql<MemberRole | null>`app_role(${projects.id})`,
};

/** The projects the caller can see, oldest first. */
export async function listProjects(tx: Tx, opts: { includeArchived?: boolean } = {}) {
  return tx
    .select(projectColumns)
    .from(projects)
    .where(opts.includeArchived ? undefined : isNull(projects.archivedAt))
    .orderBy(asc(projects.createdAt), asc(projects.id)) as Promise<ProjectRow[]>;
}

export async function findProject(tx: Tx, id: string): Promise<ProjectRow | null> {
  const rows = (await tx
    .select(projectColumns)
    .from(projects)
    .where(eq(projects.id, id))
    .limit(1)) as ProjectRow[];
  return rows[0] ?? null;
}

export async function findProjectBySlug(tx: Tx, slug: string): Promise<ProjectRow | null> {
  const rows = (await tx
    .select(projectColumns)
    .from(projects)
    .where(and(eq(projects.slug, slug), isNull(projects.archivedAt)))
    .limit(1)) as ProjectRow[];
  return rows[0] ?? null;
}

export interface NewProject {
  id: string;
  slug: string;
  name: string;
  timeZone?: string;
  defaultNoteVisibility?: Visibility;
}

/** Create a project and make the caller its owner (RLS: the workspace owner only). */
export async function insertProject(tx: Tx, actor: Actor, p: NewProject): Promise<void> {
  await tx.insert(projects).values({
    id: p.id,
    workspaceId: actor.workspaceId,
    slug: p.slug,
    name: p.name,
    timeZone: p.timeZone ?? null,
    ...(p.defaultNoteVisibility ? { defaultNoteVisibility: p.defaultNoteVisibility } : {}),
  });
  await tx.insert(projectMembers).values({
    workspaceId: actor.workspaceId,
    projectId: p.id,
    userId: actor.userId,
    role: 'owner',
  });
}

export async function slugTaken(tx: Tx, slug: string): Promise<boolean> {
  const rows = await tx
    .select({ id: projects.id })
    .from(projects)
    .where(eq(projects.slug, slug))
    .limit(1);
  return rows.length > 0;
}

/** The caller's workspace (its time zone is the default for Inbox items). */
export async function getWorkspace(tx: Tx) {
  const rows = await tx
    .select({ id: workspaces.id, name: workspaces.name, timeZone: workspaces.timeZone })
    .from(workspaces)
    .limit(1);
  return rows[0] ?? null;
}

export async function displayNames(tx: Tx, ids: string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const rows = await tx
    .select({ id: users.id, name: users.displayName })
    .from(users)
    .where(sql`${users.id} in ${ids}`);
  return new Map(rows.map((r) => [r.id, r.name]));
}

/** The caller's workspace with its settings (RLS: owner or member). */
export async function getWorkspaceSettings(tx: Tx) {
  const rows = await tx
    .select({
      id: workspaces.id,
      name: workspaces.name,
      domain: workspaces.domain,
      timeZone: workspaces.timeZone,
      weekStart: workspaces.weekStart,
      ownerUserId: workspaces.ownerUserId,
    })
    .from(workspaces)
    .limit(1);
  return rows[0] ?? null;
}

/** Update the caller's workspace; returns false when RLS let nothing through (not the owner). */
export async function updateWorkspace(
  tx: Tx,
  id: string,
  patch: { name?: string; timeZone?: string; weekStart?: number },
): Promise<boolean> {
  const rows = await tx
    .update(workspaces)
    .set(patch)
    .where(eq(workspaces.id, id))
    .returning({ id: workspaces.id });
  return rows.length > 0;
}

/** Update a project; returns false when RLS let nothing through (below manager). */
export async function updateProject(
  tx: Tx,
  id: string,
  patch: {
    name?: string;
    timeZone?: string | null;
    defaultNoteVisibility?: Visibility;
    archivedAt?: Date | null;
  },
): Promise<boolean> {
  const rows = await tx
    .update(projects)
    .set(patch)
    .where(eq(projects.id, id))
    .returning({ id: projects.id });
  return rows.length > 0;
}
