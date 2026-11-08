import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createHash, randomBytes } from 'node:crypto';
import { createHubAuth, createInvite } from '@xjournal/auth';
import { newId } from '@xjournal/core';
import { connectPostgres, type DbHandle, schema, withActor } from '@xjournal/db';
import { createTestDb } from '@xjournal/db/testing';
import { eq, sql } from 'drizzle-orm';
import { SoftAuthenticator } from '../../../packages/auth/test/soft-authenticator';
import { createApp } from '../src/app';
import { Browser } from './browser';

// Spikes 1 and 2 (docs/adr/0001, 0002), end to end through the HTTP app:
//  - invite link + code → passkey registration → device approval → sign-in
//  - MCP OAuth 2.1 + PKCE (hosted mode): discovery → dynamic registration → consent → token → /mcp

// A real listener: the MCP token check fetches the hub's own JWKS over HTTP.
let ORIGIN = '';
let server: ReturnType<typeof Bun.serve>;
const SECRET = 'test-secret-0123456789abcdef0123456789abcdef';

let h: DbHandle;
let authHandle: DbHandle;
let app: ReturnType<typeof createApp>;
const ids = { alice: newId(), ws: newId(), project: newId() };

beforeAll(async () => {
  h = await createTestDb();
  // Better Auth runs as hub_auth on Postgres. PGlite has one connection, so there it shares
  // the test handle (superuser); the Postgres run is what proves hub_auth's grants suffice.
  authHandle =
    h.kind === 'postgres' && h.url ? connectPostgres(h.url, { role: 'hub_auth', max: 4 }) : h;

  await h.db.insert(schema.users).values({ id: ids.alice, displayName: 'Alice' });
  await h.db.insert(schema.workspaces).values({
    id: ids.ws,
    domain: 'personal',
    name: 'Family',
    ownerUserId: ids.alice,
    timeZone: 'UTC',
  });
  await h.db
    .insert(schema.projects)
    .values({ id: ids.project, workspaceId: ids.ws, slug: 'home', name: 'Home' });
  await h.db
    .insert(schema.projectMembers)
    .values({ workspaceId: ids.ws, projectId: ids.project, userId: ids.alice, role: 'owner' });

  server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: (req) => app.fetch(req) });
  ORIGIN = `http://localhost:${server.port}`;
  const auth = createHubAuth({ authDb: authHandle.db, baseURL: ORIGIN, secret: SECRET });
  app = createApp({
    config: { mode: 'hosted', localToken: 'unused', authSecret: SECRET, baseURL: ORIGIN },
    db: h,
    auth,
  });
});

afterAll(async () => {
  server?.stop(true);
  if (authHandle && authHandle !== h) await authHandle.close();
  await h?.close();
});

const alice = { userId: ids.alice, workspaceId: ids.ws };
const invite = (role: 'viewer' | 'contributor' = 'contributor') =>
  createInvite(h.db, SECRET, alice, { projectId: ids.project, displayName: 'Sam', role });

/** Register a passkey through an invite; returns the browser, authenticator and response. */
async function join(token: string, code: string) {
  const browser = new Browser((r) => app.fetch(r), ORIGIN);
  const device = new SoftAuthenticator(ORIGIN);
  const redeem = await browser.post('/api/v1/auth/invites/redeem', { token, code });
  if (redeem.status !== 200) return { browser, device, redeem, verify: null };
  const options = (await redeem.json()) as {
    challenge: string;
    rp: { id: string };
    user: { id: string };
  };
  const verify = await browser.post('/api/auth/passkey/verify-registration', {
    response: device.register(options),
    name: 'Test phone',
  });
  return { browser, device, redeem, verify };
}

async function signIn(browser: Browser, device: SoftAuthenticator) {
  const opts = (await (
    await browser.get('/api/auth/passkey/generate-authenticate-options')
  ).json()) as {
    challenge: string;
    rpId: string;
  };
  return browser.post('/api/auth/passkey/verify-authentication', {
    response: device.authenticate(opts),
  });
}

describe('spike 1: invite + passkey + device approval', () => {
  let joined: Awaited<ReturnType<typeof join>>;
  let link: Awaited<ReturnType<typeof invite>>;
  let newUserId: string;

  test('a wrong code is rejected and counted', async () => {
    link = await invite();
    const r = await join(link.token, '000-000');
    expect(r.redeem.status).toBe(422);
    const body = (await r.redeem.json()) as { code: string; detail: string };
    expect(body.code).toBe('invite_code_invalid');
    expect(body.detail).toBe('4 attempts remaining');
  });

  test('link + code register a passkey, create the user and membership, and use the invite', async () => {
    joined = await join(link.token, link.code);
    expect(joined.verify?.status).toBe(200);

    const used = (
      await h.db.select().from(schema.invites).where(eq(schema.invites.id, link.inviteId))
    )[0];
    expect(used?.usedAt).not.toBeNull();
    newUserId = used?.usedByUserId as string;

    const member = await h.db
      .select()
      .from(schema.projectMembers)
      .where(eq(schema.projectMembers.userId, newUserId));
    expect(member).toHaveLength(1);
    expect(member[0]?.role).toBe('contributor');

    const pk = (
      await h.db.select().from(schema.passkeys).where(eq(schema.passkeys.userId, newUserId))
    )[0];
    expect(pk?.status).toBe('pending'); // projects default to require_device_approval
    expect(pk?.createdViaInviteId).toBe(link.inviteId);
    expect(pk?.deviceLabel).toBe('Test phone');

    const user = (await h.db.select().from(schema.users).where(eq(schema.users.id, newUserId)))[0];
    expect(user?.displayName).toBe('Sam');
    expect(user?.email).toBeNull();
  });

  test('registration never creates a session by itself', async () => {
    const s = await joined.browser.get('/api/auth/get-session');
    expect(await s.json()).toBeNull();
  });

  test('a used link fails visibly (leak detection)', async () => {
    const again = await join(link.token, link.code);
    expect(again.redeem.status).toBe(409);
    expect(((await again.redeem.json()) as { code: string }).code).toBe('already_used');
  });

  test('a pending device cannot sign in', async () => {
    const res = await signIn(joined.browser, joined.device);
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe('device_pending');
  });

  test('after a manager approves the device, sign-in opens a session', async () => {
    const approved = await withActor(h.db, alice, (tx) =>
      tx
        .update(schema.passkeys)
        .set({ status: 'approved', approvedBy: ids.alice, approvedAt: sql`now()` })
        .where(eq(schema.passkeys.userId, newUserId))
        .returning({ id: schema.passkeys.id }),
    );
    expect(approved).toHaveLength(1);

    const res = await signIn(joined.browser, joined.device);
    expect(res.status).toBe(200);
    const session = (await (await joined.browser.get('/api/auth/get-session')).json()) as {
      user: { id: string; name: string };
    };
    expect(session.user.id).toBe(newUserId);
    expect(session.user.name).toBe('Sam'); // Better Auth's field name for display_name
  });

  test('five wrong codes invalidate the invite', async () => {
    const other = await invite('viewer');
    for (let i = 0; i < 5; i++)
      expect((await join(other.token, '999-999')).redeem.status).toBe(422);
    const last = await join(other.token, other.code);
    expect(last.redeem.status).toBe(410);
  });

  test('a recovery invite re-registers an existing member and revokes their old passkeys', async () => {
    const rec = await createInvite(h.db, SECRET, alice, {
      projectId: ids.project,
      displayName: 'Sam',
      role: 'contributor',
      recoveryForUserId: newUserId,
    });
    const r = await join(rec.token, rec.code);
    expect(r.verify?.status).toBe(200);
    const keys = await h.db
      .select()
      .from(schema.passkeys)
      .where(eq(schema.passkeys.userId, newUserId));
    expect(keys.map((k) => k.status).sort()).toEqual(['pending', 'revoked']);
    expect(
      await h.db.select().from(schema.users).where(eq(schema.users.displayName, 'Sam')),
    ).toHaveLength(1);
  });

  // Reused by spike 2.
  test('exposes a signed-in browser for the OAuth flow', () => {
    signedIn = joined.browser;
    signedInUserId = newUserId;
    expect(signedIn).toBeDefined();
  });
});

let signedIn: Browser;
let signedInUserId: string;

describe('spike 2: MCP OAuth 2.1 + PKCE (hosted mode)', () => {
  const redirectUri = 'http://127.0.0.1:33418/callback';
  const resource = () => `${ORIGIN}/mcp`;

  test('/mcp without a token answers 401 with RFC 9728 resource metadata', async () => {
    const res = await app.fetch(new Request(resource(), { method: 'POST', body: '{}' }));
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toContain('resource_metadata=');
  });

  test('full flow: discovery → registration → authorize → consent → token → tools/call', async () => {
    const anon = new Browser((r) => app.fetch(r), ORIGIN);

    const prm = (await (await anon.get('/.well-known/oauth-protected-resource/mcp')).json()) as {
      resource: string;
      authorization_servers: string[];
    };
    expect(prm.resource).toBe(resource());
    const issuer = new URL(prm.authorization_servers[0] as string);

    const asMeta = (await (
      await anon.get(`/.well-known/oauth-authorization-server${issuer.pathname.replace(/\/$/, '')}`)
    ).json()) as {
      authorization_endpoint: string;
      token_endpoint: string;
      registration_endpoint: string;
      code_challenge_methods_supported: string[];
    };
    expect(asMeta.code_challenge_methods_supported).toContain('S256');

    const reg = await anon.post(new URL(asMeta.registration_endpoint).pathname, {
      client_name: 'Claude Code (test)',
      redirect_uris: [redirectUri],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    });
    if (reg.status >= 300) console.error('register:', reg.status, await reg.clone().text());
    expect(reg.status).toBeLessThan(300);
    const client = (await reg.json()) as { client_id: string };

    const verifier = randomBytes(32).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const authorize = new URL(asMeta.authorization_endpoint);
    for (const [k, v] of Object.entries({
      response_type: 'code',
      client_id: client.client_id,
      redirect_uri: redirectUri,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      scope: 'openid offline_access',
      state: 'xyz',
      resource: resource(),
    })) {
      authorize.searchParams.set(k, v);
    }

    let res = await signedIn.get(authorize.pathname + authorize.search);
    let location = res.headers.get('location') ?? '';
    if (location.includes('/consent')) {
      const consentQuery = new URL(location, ORIGIN).search.slice(1);
      res = await signedIn.post('/api/auth/oauth2/consent', {
        accept: true,
        oauth_query: consentQuery,
      });
      location = ((await res.json()) as { url: string }).url;
    }
    const callback = new URL(location, ORIGIN);
    expect(callback.origin + callback.pathname).toBe(redirectUri);
    expect(callback.searchParams.get('state')).toBe('xyz');
    const code = callback.searchParams.get('code');
    expect(code).toBeTruthy();

    const tokenRes = await anon.request(new URL(asMeta.token_endpoint).pathname, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: code as string,
        redirect_uri: redirectUri,
        client_id: client.client_id,
        code_verifier: verifier,
        resource: resource(),
      }).toString(),
    });
    const tokens = (await tokenRes.json()) as { access_token: string; refresh_token?: string };
    expect(tokenRes.status).toBe(200);
    expect(tokens.access_token.split('.')).toHaveLength(3); // a JWT, audience-bound to /mcp

    const call = await app.fetch(
      new Request(resource(), {
        method: 'POST',
        headers: {
          authorization: `Bearer ${tokens.access_token}`,
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'whoami', arguments: {} },
        }),
      }),
    );
    expect(call.status).toBe(200);
    const rpc = (await call.json()) as {
      result: { structuredContent: { via: string; userId: string } };
    };
    expect(rpc.result.structuredContent).toMatchObject({ via: 'oauth', userId: signedInUserId });

    // Stored OAuth tokens are hashed, not plaintext (schema.md §0).
    if (tokens.refresh_token) {
      const stored = await h.db
        .select({ token: schema.oauthRefreshToken.token })
        .from(schema.oauthRefreshToken);
      expect(stored.map((s) => s.token)).not.toContain(tokens.refresh_token);
    }
  });
});
