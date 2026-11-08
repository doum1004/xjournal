import { newId } from '@xjournal/core';
import { sql } from 'drizzle-orm';
import { type Actor, type DbHandle, type Tx, withActor, withAuthRole } from '../src';
import {
  connectorAccounts,
  invites,
  passkeys,
  projectMembers,
  projects,
  recordRevisions,
  records,
  sessions,
  users,
  workspaces,
} from '../src/schema';

/**
 * Seed data, inserted as the migration (superuser) role, so RLS doesn't apply here.
 *
 * Workspace W:   alice owns W and project P; P members: dave (manager), bob (contributor),
 *                carol (viewer). Project Q: eve (owner), bob (contributor).
 * Workspace W2:  mallory owns W2 and project R.
 */
export async function seed(h: DbHandle) {
  const id = () => newId();
  const u = {
    alice: id(),
    bob: id(),
    carol: id(),
    dave: id(),
    eve: id(),
    mallory: id(),
  };
  const ws = { W: id(), W2: id() };
  const p = { P: id(), Q: id(), R: id() };
  const db = h.db;

  await db.insert(users).values(
    Object.entries(u).map(([name, uid]) => ({
      id: uid,
      displayName: name,
      email: `${name}@example.test`,
    })),
  );
  await db.insert(workspaces).values([
    { id: ws.W, domain: 'work', name: 'Work', ownerUserId: u.alice, timeZone: 'America/New_York' },
    { id: ws.W2, domain: 'personal', name: 'Other', ownerUserId: u.mallory, timeZone: 'UTC' },
  ]);
  await db.insert(projects).values([
    { id: p.P, workspaceId: ws.W, slug: 'p', name: 'P' },
    { id: p.Q, workspaceId: ws.W, slug: 'q', name: 'Q' },
    { id: p.R, workspaceId: ws.W2, slug: 'r', name: 'R' },
  ]);
  await db.insert(projectMembers).values([
    { workspaceId: ws.W, projectId: p.P, userId: u.alice, role: 'owner' },
    { workspaceId: ws.W, projectId: p.P, userId: u.dave, role: 'manager' },
    { workspaceId: ws.W, projectId: p.P, userId: u.bob, role: 'contributor' },
    { workspaceId: ws.W, projectId: p.P, userId: u.carol, role: 'viewer' },
    { workspaceId: ws.W, projectId: p.Q, userId: u.eve, role: 'owner' },
    { workspaceId: ws.W, projectId: p.Q, userId: u.bob, role: 'contributor' },
    { workspaceId: ws.W2, projectId: p.R, userId: u.mallory, role: 'owner' },
  ]);

  const as = <T>(
    user: keyof typeof u,
    fn: (tx: Tx) => Promise<T>,
    workspace: keyof typeof ws = 'W',
  ) =>
    withActor(db, { userId: u[user], workspaceId: ws[workspace] } satisfies Actor, fn).catch(
      unwrap,
    );
  const asAuth = <T>(fn: (tx: Tx) => Promise<T>) => withAuthRole(db, fn).catch(unwrap);

  return { db, u, ws, p, as, asAuth };
}

export type Seed = Awaited<ReturnType<typeof seed>>;

/** Insert a record and its first revision as the superuser. */
export async function seedRecord(
  s: Seed,
  opts: {
    owner: keyof Seed['u'];
    project: keyof Seed['p'] | null;
    visibility: 'project' | 'private' | 'restricted';
    audience?: (keyof Seed['u'])[];
    workspace?: keyof Seed['ws'];
  },
) {
  const recordId = newId();
  const revisionId = newId();
  const workspaceId = s.ws[opts.workspace ?? 'W'];
  const projectId = opts.project ? s.p[opts.project] : null;
  await s.db.insert(records).values({
    id: recordId,
    workspaceId,
    source: 'note',
    externalId: recordId,
    kind: 'note',
    tier: 'manual',
    ownerUserId: s.u[opts.owner],
    isMine: true,
    eventTime: new Date(),
    capturedAt: new Date(),
    applicableDate: '2026-11-08',
    projectId,
    routingStatus: projectId ? 'confirmed' : 'needs_review',
    routedBy: 'user',
    visibility: opts.visibility,
    currentRevisionId: revisionId,
    title: `note by ${opts.owner}`,
  });
  await s.db.insert(recordRevisions).values({
    id: revisionId,
    recordId,
    workspaceId,
    revisionNo: 1,
    kind: 'created',
    contentHash: 'x',
    title: `note by ${opts.owner}`,
    projectId,
    applicableDate: '2026-11-08',
    visibility: opts.visibility,
  });
  for (const who of opts.audience ?? []) {
    await s.db.execute(
      sql`insert into record_audiences (record_id, user_id, workspace_id) values (${recordId}, ${s.u[who]}, ${workspaceId})`,
    );
  }
  return { recordId, revisionId, workspaceId };
}

export async function seedPasskey(s: Seed, owner: keyof Seed['u']) {
  const pkId = newId();
  await s.db.insert(passkeys).values({
    id: pkId,
    userId: s.u[owner],
    credentialId: `cred-${pkId}`,
    publicKey: 'pk',
  });
  return pkId;
}

export async function seedSession(s: Seed, owner: keyof Seed['u']) {
  const sid = newId();
  await s.db.insert(sessions).values({
    id: sid,
    userId: s.u[owner],
    token: `tok-${sid}`,
    expiresAt: new Date(Date.now() + 3600_000),
  });
  return sid;
}

export async function seedConnector(s: Seed, owner: keyof Seed['u']) {
  const cid = newId();
  await s.db.insert(connectorAccounts).values({
    id: cid,
    workspaceId: s.ws.W,
    ownerUserId: s.u[owner],
    source: 'github:github.com',
    displayName: 'GitHub',
    authType: 'pat',
  });
  return cid;
}

export async function seedInvite(s: Seed, project: keyof Seed['p'] = 'P') {
  const iid = newId();
  await s.db.insert(invites).values({
    id: iid,
    workspaceId: s.ws.W,
    projectId: s.p[project],
    kind: 'join',
    role: 'viewer',
    displayName: 'Guest',
    tokenHash: `t-${iid}`,
    codeHash: 'c',
    createdBy: s.u.alice,
    expiresAt: new Date(Date.now() + 86400_000),
  });
  return iid;
}

/** Count rows visible to the current transaction's role. */
export async function visible(tx: Tx, table: string, where = 'true'): Promise<number> {
  const r = await tx.execute<{ n: number }>(
    sql.raw(`select count(*)::int as n from ${table} where ${where}`),
  );
  return r.rows[0]?.n ?? 0;
}

/** Rows affected by an UPDATE/DELETE (RLS silently filters rows the USING clause hides). */
export async function affected(tx: Tx, statement: string): Promise<number> {
  const r = await tx.execute(sql.raw(statement));
  return r.rowCount ?? r.affectedRows ?? 0;
}

/** Drizzle wraps driver errors as "Failed query: …"; surface the Postgres message. */
export function unwrap(e: unknown): never {
  const err = e as { message?: string; cause?: { message?: string } };
  throw new Error(err.cause?.message ?? err.message ?? String(e));
}

export const RLS_VIOLATION = /row-level security|permission denied/i;
