import { and, eq, isNull, sql } from 'drizzle-orm';
import { type Actor, withActor, withAuthRole } from '../actor';
import type { HubDb } from '../client';
import { invites, passkeys, projectMembers, projects, users } from '../schema';

// Sign-in data access for packages/auth. Everything here runs as `hub_auth`, because it
// happens before a user is known (docs/adr/0001).

export type InviteRow = typeof invites.$inferSelect;

export async function findInviteByTokenHash(
  db: HubDb,
  tokenHash: string,
): Promise<InviteRow | null> {
  return withAuthRole(db, async (tx) => {
    const rows = await tx.select().from(invites).where(eq(invites.tokenHash, tokenHash)).limit(1);
    return rows[0] ?? null;
  });
}

export async function findInviteById(db: HubDb, id: string): Promise<InviteRow | null> {
  return withAuthRole(db, async (tx) => {
    const rows = await tx.select().from(invites).where(eq(invites.id, id)).limit(1);
    return rows[0] ?? null;
  });
}

/** Count a wrong confirmation code. Returns the new count. */
export async function recordFailedInviteAttempt(db: HubDb, id: string): Promise<number> {
  return withAuthRole(db, async (tx) => {
    const rows = await tx
      .update(invites)
      .set({ failedAttempts: sql`${invites.failedAttempts} + 1` })
      .where(eq(invites.id, id))
      .returning({ n: invites.failedAttempts });
    return rows[0]?.n ?? 0;
  });
}

export interface ConsumeInviteInput {
  inviteId: string;
  userId: string;
  displayName: string;
}

export type ConsumeInviteResult =
  | { ok: true; invite: InviteRow; requireDeviceApproval: boolean }
  | { ok: false; reason: 'already_used' | 'revoked' | 'expired' | 'invalid' };

/**
 * Atomically use an invite: mark it used, create the user (join) or revoke the member's old
 * passkeys (recovery), and add the membership. Runs inside the passkey registration, so a
 * failure here aborts the registration.
 */
export async function consumeInvite(
  db: HubDb,
  input: ConsumeInviteInput,
): Promise<ConsumeInviteResult> {
  return withAuthRole(db, async (tx) => {
    // Lock the invite so two registrations racing on one leaked link can't both succeed.
    const invite = (
      await tx.select().from(invites).where(eq(invites.id, input.inviteId)).for('update')
    )[0];
    if (!invite) return { ok: false, reason: 'invalid' };
    if (invite.usedAt) return { ok: false, reason: 'already_used' };
    if (invite.revokedAt) return { ok: false, reason: 'revoked' };
    if (invite.expiresAt <= new Date()) return { ok: false, reason: 'expired' };
    if (invite.failedAttempts >= 5) return { ok: false, reason: 'invalid' };

    if (invite.kind === 'join') {
      await tx.insert(users).values({ id: input.userId, displayName: input.displayName });
      await tx.insert(projectMembers).values({
        workspaceId: invite.workspaceId,
        projectId: invite.projectId,
        userId: input.userId,
        role: invite.role,
        invitedBy: invite.createdBy,
      });
    } else {
      // Recovery: the old passkeys stop working once the new one is registered (spec §11.5).
      await tx
        .update(passkeys)
        .set({ status: 'revoked', revokedAt: sql`now()` })
        .where(and(eq(passkeys.userId, input.userId), isNull(passkeys.revokedAt)));
    }

    await tx
      .update(invites)
      .set({ usedAt: sql`now()`, usedByUserId: input.userId })
      .where(eq(invites.id, invite.id));

    const project = (await tx.select().from(projects).where(eq(projects.id, invite.projectId)))[0];
    return { ok: true, invite, requireDeviceApproval: project?.requireDeviceApproval ?? true };
  });
}

/** After Better Auth stores a passkey: link it to its invite and set its approval state. */
export async function finishInvitePasskey(
  db: HubDb,
  credentialId: string,
): Promise<{ status: 'pending' | 'approved' } | null> {
  return withAuthRole(db, async (tx) => {
    const pk = (await tx.select().from(passkeys).where(eq(passkeys.credentialId, credentialId)))[0];
    if (!pk) return null;
    const invite = (
      await tx
        .select()
        .from(invites)
        .where(
          and(
            eq(invites.usedByUserId, pk.userId),
            sql`${invites.usedAt} > now() - interval '10 minutes'`,
          ),
        )
        .orderBy(sql`${invites.usedAt} desc`)
        .limit(1)
    )[0];
    if (!invite) return { status: pk.status === 'approved' ? 'approved' : 'pending' };
    const project = (await tx.select().from(projects).where(eq(projects.id, invite.projectId)))[0];
    const status = project?.requireDeviceApproval === false ? 'approved' : 'pending';
    await tx
      .update(passkeys)
      .set({
        createdViaInviteId: invite.id,
        status,
        approvedAt: status === 'approved' ? sql`now()` : null,
      })
      .where(eq(passkeys.id, pk.id));
    return { status };
  });
}

/** Sign-in gate: a device must be approved before it can open a session. */
export async function passkeyStatusForSignIn(
  db: HubDb,
  credentialId: string,
): Promise<'pending' | 'approved' | 'rejected' | 'revoked' | null> {
  return withAuthRole(db, async (tx) => {
    const rows = await tx
      .update(passkeys)
      .set({ lastUsedAt: sql`now()` })
      .where(eq(passkeys.credentialId, credentialId))
      .returning({ status: passkeys.status });
    return rows[0]?.status ?? null;
  });
}

export type NewInvite = Omit<typeof invites.$inferInsert, 'workspaceId' | 'createdBy'>;

/** Create an invite as `actor` (a manager or owner of the project; enforced by RLS). */
export async function insertInvite(db: HubDb, actor: Actor, invite: NewInvite): Promise<void> {
  await withActor(db, actor, async (tx) => {
    await tx
      .insert(invites)
      .values({ ...invite, workspaceId: actor.workspaceId, createdBy: actor.userId });
  });
}
