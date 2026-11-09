import { requireMcpAuth } from '@better-auth/mcp';
import { type HubAuth, redeemInvite } from '@xjournal/auth';
import { type DbHandle, migrationStatus } from '@xjournal/db';
import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { z } from 'zod';
import { bearer, createApi, problem, sameToken } from './api';
import type { Config } from './config';
import { handleMcp } from './mcp';
import { webHandler } from './web';

export interface AppDeps {
  config: Pick<Config, 'mode' | 'localToken' | 'authSecret' | 'baseURL'>;
  /** The service-layer database (hub_app via withActor). */
  db: DbHandle;
  auth?: HubAuth;
  /** The built web UI; defaults to apps/web/dist. */
  webDist?: string;
}

export function createApp(deps: AppDeps) {
  const app = new Hono();
  const { config, db, auth } = deps;

  // Health (api.md §1): no authentication, no data.
  app.get('/healthz', (c) => c.json({ status: 'ok' }));
  app.get('/readyz', async (c) => {
    try {
      await db.db.execute(sql`select 1`);
      const m = await migrationStatus(db);
      if (!m.upToDate) return c.json({ status: 'migrations_pending', ...m }, 503);
      return c.json({ status: 'ready', ...m });
    } catch {
      return c.json({ status: 'database_unavailable' }, 503);
    }
  });

  if (auth) {
    // Step 1 of joining (api.md §3.1): link token + confirmation code → WebAuthn registration
    // options. The response also sets Better Auth's signed challenge cookie.
    const Redeem = z.object({ token: z.string().min(1), code: z.string().min(1) });
    app.post('/api/v1/auth/invites/redeem', async (c) => {
      const parsed = Redeem.safeParse(await c.req.json().catch(() => null));
      if (!parsed.success) return problem(400, 'bad_request', 'Invalid body');
      const r = await redeemInvite(db.db, config.authSecret, parsed.data.token, parsed.data.code);
      if (!r.ok) {
        const detail =
          r.code === 'invite_code_invalid'
            ? `${r.attemptsRemaining} attempts remaining`
            : undefined;
        return problem(r.status, r.code, 'Invite not accepted', detail ? { detail } : {});
      }
      return auth.api.generatePasskeyRegistrationOptions({
        query: { context: r.ticket },
        headers: c.req.raw.headers,
        asResponse: true,
      });
    });

    // Better Auth: passkeys, sessions, OAuth 2.1 for MCP (+ its well-known metadata).
    app.on(['GET', 'POST'], '/api/auth/*', (c) => auth.handler(c.req.raw));
    app.get('/.well-known/oauth-authorization-server/*', (c) => auth.handler(c.req.raw));
    app.get('/.well-known/oauth-authorization-server', (c) => auth.handler(c.req.raw));
    app.get('/.well-known/oauth-protected-resource/*', (c) => auth.handler(c.req.raw));
    app.get('/.well-known/oauth-protected-resource', (c) => auth.handler(c.req.raw));
  }

  // REST API (api.md §3), after the auth routes so /api/v1/auth/* is matched first.
  app.route('/api/v1', createApi({ config, db }));

  // MCP (api.md §5). Local mode: the per-install token. Hosted: OAuth 2.1 access tokens.
  const oauthMcp = auth
    ? requireMcpAuth(
        auth,
        (req, claims) =>
          handleMcp(req, {
            via: 'oauth',
            userId: typeof claims.sub === 'string' ? claims.sub : null,
            scopes: typeof claims.scope === 'string' ? claims.scope.split(' ') : [],
            clientId: typeof claims.azp === 'string' ? claims.azp : undefined,
          }),
        { resource: new URL('/mcp', config.baseURL).toString() },
      )
    : null;

  app.all('/mcp', async (c) => {
    const req = c.req.raw;
    if (config.mode === 'local') {
      const token = bearer(req);
      if (!token || !sameToken(token, config.localToken)) {
        return problem(401, 'unauthenticated', 'Missing or invalid token');
      }
      return handleMcp(req, { via: 'local', userId: null, scopes: ['read', 'write'] });
    }
    if (!oauthMcp) return problem(503, 'unavailable', 'Authentication is not configured');
    return oauthMcp(req);
  });

  // The web UI, last, so it never shadows the API. No build yet: a hint instead of a blank page.
  const web = webHandler(deps.webDist);
  app.get('*', async (c) => {
    const res = await web(new URL(c.req.url).pathname);
    return (
      res ??
      c.text('The web UI is not built yet. Run `bun run web:build`, or `bun run web:dev`.', 404)
    );
  });

  return app;
}
