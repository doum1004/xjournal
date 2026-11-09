import { timingSafeEqual } from 'node:crypto';
import type { DbHandle, LocalOwner } from '@xjournal/db';
import * as svc from '@xjournal/services';
import { type Context, Hono } from 'hono';
import type { Config } from './config';

// REST adapter over the service layer (api.md §1, §3). Routes only parse HTTP and call one
// service operation each; all rules and authorization live in packages/services.

type Env = { Variables: { ctx: svc.Ctx } };

export function problem(
  status: number,
  code: string,
  title: string,
  extra: { detail?: string; errors?: unknown } = {},
) {
  return Response.json(
    { type: 'about:blank', title, status, code, ...extra },
    { status, headers: { 'content-type': 'application/problem+json' } },
  );
}

export function bearer(req: Request): string | null {
  const h = req.headers.get('authorization');
  return h?.startsWith('Bearer ') ? h.slice(7) : null;
}

export function sameToken(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

async function body(c: Context): Promise<unknown> {
  return c.req.json().catch(() => {
    throw new svc.ServiceError(400, 'bad_request', 'Expected a JSON body');
  });
}

export function createApi(deps: { config: Pick<Config, 'mode' | 'localToken'>; db: DbHandle }) {
  const { config, db } = deps;
  const api = new Hono<Env>();

  // The local owner never changes once `hub init` has run, so it's looked up once.
  let owner: LocalOwner | null = null;

  api.onError((err) => {
    if (err instanceof svc.ServiceError) {
      return problem(err.status, err.code, err.message, err.errors ? { errors: err.errors } : {});
    }
    console.error(JSON.stringify({ level: 'error', msg: 'unhandled', error: String(err) }));
    return problem(500, 'internal', 'Internal error');
  });

  api.use('*', async (c, next) => {
    if (config.mode !== 'local') {
      // Hosted mode resolves the user from a session or access token (M7).
      return problem(503, 'unavailable', 'The REST API is only available in local mode for now');
    }
    const token = bearer(c.req.raw);
    if (!token || !sameToken(token, config.localToken)) {
      return problem(401, 'unauthenticated', 'Missing or invalid token');
    }
    owner ??= await svc.localOwner(db.db);
    c.set('ctx', { db: db.db, actor: owner });
    await next();
  });

  api.get('/me', async (c) => {
    const ctx = c.get('ctx');
    return c.json({
      user: { id: ctx.actor.userId, name: owner?.displayName },
      projects: await svc.listProjects(ctx),
    });
  });

  api.get('/projects', async (c) => c.json({ items: await svc.listProjects(c.get('ctx')) }));
  api.post('/projects', async (c) =>
    c.json(await svc.createProject(c.get('ctx'), await body(c)), 201),
  );

  api.post('/notes', async (c) =>
    c.json(await svc.addNote(c.get('ctx'), await body(c), 'api'), 201),
  );
  api.patch('/notes/:id', async (c) =>
    c.json(await svc.editNote(c.get('ctx'), c.req.param('id'), await body(c))),
  );

  api.get('/projects/:p/days', async (c) =>
    c.json({ items: await svc.listDays(c.get('ctx'), c.req.param('p'), c.req.query()) }),
  );
  api.get('/projects/:p/days/:date', async (c) =>
    c.json(await svc.getDay(c.get('ctx'), c.req.param('p'), c.req.param('date'))),
  );

  api.get('/inbox', async (c) => c.json(await svc.listInbox(c.get('ctx'), c.req.query())));
  api.get('/search', async (c) => c.json(await svc.search(c.get('ctx'), c.req.query())));

  api.get('/records/:id', async (c) =>
    c.json(await svc.getRecord(c.get('ctx'), c.req.param('id'))),
  );
  api.get('/records/:id/revisions', async (c) =>
    c.json({ items: await svc.listRevisions(c.get('ctx'), c.req.param('id')) }),
  );
  api.post('/records/:id/route', async (c) =>
    c.json(await svc.routeRecord(c.get('ctx'), c.req.param('id'), await body(c))),
  );

  api.all('*', () => problem(404, 'not_found', 'No such route'));
  return api;
}
