import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';

/** sha256 hex, for high-entropy tokens (schema.md §0: tokens are stored hashed). */
export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/**
 * Keyed hash for low-entropy secrets (the 6-digit invite code). A plain hash of a code
 * could be brute-forced from a database dump; this needs the server secret too.
 */
export function hmac(secret: string, value: string): string {
  return createHmac('sha256', secret).update(value).digest('hex');
}

export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** The invite link token: 32 random bytes, base64url. */
export function newLinkToken(): string {
  return randomBytes(32).toString('base64url');
}

/** The confirmation code passed on through another channel, e.g. '482-913' (spec §11.5). */
export function newConfirmationCode(): string {
  const n = randomInt(0, 1_000_000).toString().padStart(6, '0');
  return `${n.slice(0, 3)}-${n.slice(3)}`;
}

export function normalizeCode(code: string): string {
  return code.replace(/\D/g, '');
}

/**
 * A short-lived, signed registration ticket: proof that the link and the code were both
 * checked. Passed to Better Auth as the passkey registration `context`.
 */
export function signTicket(
  secret: string,
  payload: { inviteId: string; userId: string },
  ttlMs = 10 * 60_000,
) {
  const body = Buffer.from(JSON.stringify({ ...payload, exp: Date.now() + ttlMs })).toString(
    'base64url',
  );
  return `${body}.${hmac(secret, body)}`;
}

export function verifyTicket(
  secret: string,
  ticket: string,
): { inviteId: string; userId: string } | null {
  const [body, sig] = ticket.split('.');
  if (!body || !sig || !safeEqual(sig, hmac(secret, body))) return null;
  try {
    const data = JSON.parse(Buffer.from(body, 'base64url').toString()) as {
      inviteId: string;
      userId: string;
      exp: number;
    };
    if (typeof data.exp !== 'number' || data.exp < Date.now()) return null;
    return { inviteId: data.inviteId, userId: data.userId };
  } catch {
    return null;
  }
}
