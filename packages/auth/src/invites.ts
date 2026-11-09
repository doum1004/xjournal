import { type MemberRole, newId } from '@xjournal/core';
import { type Actor, authRepo, type HubDb } from '@xjournal/db';
import {
  hmac,
  newConfirmationCode,
  newLinkToken,
  normalizeCode,
  safeEqual,
  sha256,
  signTicket,
} from './tokens';

export const INVITE_TTL_MS = 24 * 60 * 60_000;
export const MAX_CODE_ATTEMPTS = 5;

export interface CreatedInvite {
  inviteId: string;
  /** Goes into the link. Shown once; only its hash is stored. */
  token: string;
  /** Passed on through a different channel. Shown once; only its keyed hash is stored. */
  code: string;
  expiresAt: Date;
}

export async function createInvite(
  db: HubDb,
  secret: string,
  actor: Actor,
  input: { projectId: string; displayName: string; role: MemberRole; recoveryForUserId?: string },
): Promise<CreatedInvite> {
  const token = newLinkToken();
  const code = newConfirmationCode();
  const inviteId = newId();
  const expiresAt = new Date(Date.now() + INVITE_TTL_MS);
  await authRepo.insertInvite(db, actor, {
    id: inviteId,
    projectId: input.projectId,
    kind: input.recoveryForUserId ? 'recovery' : 'join',
    role: input.role,
    forUserId: input.recoveryForUserId ?? null,
    displayName: input.displayName,
    tokenHash: sha256(token),
    codeHash: hmac(secret, normalizeCode(code)),
    expiresAt,
  });
  return { inviteId, token, code, expiresAt };
}

export type RedeemError =
  | { code: 'not_found'; status: 404 }
  | { code: 'invite_expired'; status: 410 }
  | { code: 'already_used'; status: 409 }
  | { code: 'invite_code_invalid'; status: 422; attemptsRemaining: number };

export type RedeemResult =
  | { ok: true; ticket: string; displayName: string }
  | ({ ok: false } & RedeemError);

/**
 * Step 1 of joining (api.md §3.1): check the link token, then the code. On success, return a
 * registration ticket. The invite is only *used* when the passkey is registered (step 2), so
 * an abandoned registration doesn't burn it. A leaked, already-used link fails visibly.
 */
export async function redeemInvite(
  db: HubDb,
  secret: string,
  token: string,
  code: string,
): Promise<RedeemResult> {
  const invite = await authRepo.findInviteByTokenHash(db, sha256(token));
  if (!invite || invite.revokedAt) return { ok: false, code: 'not_found', status: 404 };
  if (invite.usedAt) return { ok: false, code: 'already_used', status: 409 };
  if (invite.expiresAt <= new Date() || invite.failedAttempts >= MAX_CODE_ATTEMPTS) {
    return { ok: false, code: 'invite_expired', status: 410 };
  }
  if (!safeEqual(invite.codeHash, hmac(secret, normalizeCode(code)))) {
    const failed = await authRepo.recordFailedInviteAttempt(db, invite.id);
    return {
      ok: false,
      code: 'invite_code_invalid',
      status: 422,
      attemptsRemaining: Math.max(0, MAX_CODE_ATTEMPTS - failed),
    };
  }
  const userId = invite.kind === 'recovery' && invite.forUserId ? invite.forUserId : newId();
  return {
    ok: true,
    ticket: signTicket(secret, { inviteId: invite.id, userId }),
    displayName: invite.displayName,
  };
}
