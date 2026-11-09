import { timingSafeEqual } from 'node:crypto';
import type { DbHandle, LocalOwner } from '@xjournal/db';
import * as svc from '@xjournal/services';
import { type Context, Hono } from 'hono';
import type { Config } from './config';
import type { Jobs } from './jobs';

// REST adapter over the service layer (api.md §1, §3). Routes only parse HTTP and call one
// service operation each; all rules and authorization live in packages/services.

type Env = { Variables: { ctx: svc.Ctx } };

export function problem(
  status: number,
  code: string,
  title: string,
  extra: { detail?: string; errors?: unknown; [k: string]: unknown } = {},
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

export interface ApiDeps {
  config: Pick<Config, 'mode' | 'localToken'>;
  db: DbHandle;
  connectors: svc.ConnectorDeps;
  /** The job queue; without it, syncs and runs happen inside the request. */
  jobs?: Jobs;
}

export function createApi(deps: ApiDeps) {
  const { config, db, connectors, jobs } = deps;
  const api = new Hono<Env>();

  // The local owner never changes once `hub init` has run, so it's looked up once.
  let owner: LocalOwner | null = null;

  api.onError((err) => {
    if (err instanceof svc.ServiceError) {
      return problem(err.status, err.code, err.message, {
        ...(err.errors ? { errors: err.errors } : {}),
        ...(err.data ?? {}),
      });
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

  // Settings (api.md §3.2, §3.2a).
  api.get('/workspace', async (c) => c.json(await svc.getWorkspace(c.get('ctx'))));
  api.patch('/workspace', async (c) =>
    c.json(await svc.updateWorkspace(c.get('ctx'), await body(c))),
  );
  api.patch('/projects/:p', async (c) =>
    c.json(await svc.updateProject(c.get('ctx'), c.req.param('p'), await body(c))),
  );
  api.post('/projects/:p/archive', async (c) => {
    await svc.archiveProject(c.get('ctx'), c.req.param('p'));
    return c.body(null, 204);
  });
  api.post('/projects/:p/days/:date/rebuild', async (c) =>
    c.json(await svc.rebuildDay(c.get('ctx'), c.req.param('p'), c.req.param('date'))),
  );

  api.get('/connector-kinds', (c) =>
    c.json({
      items: connectors.registry.list().map((d) => ({
        ...d,
        configSchema: connectors.registry.get(d.kind)?.configSchema?.() ?? null,
      })),
    }),
  );
  api.get('/connectors', async (c) => c.json({ items: await svc.listConnectors(c.get('ctx')) }));
  api.post('/connectors', async (c) =>
    c.json(await svc.addConnector(c.get('ctx'), connectors, await body(c)), 201),
  );
  api.patch('/connectors/:id', async (c) =>
    c.json(await svc.updateConnector(c.get('ctx'), connectors, c.req.param('id'), await body(c))),
  );
  api.put('/connectors/:id/secret', async (c) => {
    await svc.replaceConnectorSecret(c.get('ctx'), connectors, c.req.param('id'), await body(c));
    return c.body(null, 204);
  });
  api.delete('/connectors/:id', async (c) => {
    await svc.removeConnector(c.get('ctx'), connectors, c.req.param('id'));
    return c.body(null, 204);
  });
  api.post('/connectors/:id/sync', async (c) => {
    const ctx = c.get('ctx');
    const id = c.req.param('id');
    const raw = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const opts = {
      ...(typeof raw.backfillFrom === 'string' ? { backfillFrom: raw.backfillFrom } : {}),
      ...(Array.isArray(raw.streams) ? { streams: raw.streams.map(String) } : {}),
    };
    if (!jobs) {
      const r = await svc.syncConnector(ctx, connectors, id, opts);
      await svc.rebuildBundles(ctx.db);
      await svc.markStaleReports(ctx.db);
      return c.json(r);
    }
    // Check access now, so a bad ID fails here rather than in the worker.
    if (!(await svc.listConnectors(ctx)).some((a) => a.id === id)) {
      throw new svc.ServiceError(404, 'not_found', 'Connector not found');
    }
    const jobId = await jobs.enqueueSync({ connectorAccountId: id, ...ctx.actor, ...opts });
    return c.json({ queued: jobId != null, alreadyRunning: jobId == null }, 202);
  });

  api.get('/identities', async (c) =>
    c.json({ items: await svc.listIdentities(c.get('ctx'), c.req.query('source')) }),
  );
  api.post('/identities', async (c) =>
    c.json(await svc.addIdentity(c.get('ctx'), await body(c)), 201),
  );
  api.delete('/identities/:id', async (c) => {
    await svc.removeIdentity(c.get('ctx'), c.req.param('id'));
    return c.body(null, 204);
  });

  // Project rules (spec §8.4, api.md §3.8).
  const ifMatch = (c: Context) => {
    const v = c.req.header('if-match')?.replace(/^W\//, '').replace(/"/g, '');
    return v && /^\d+$/.test(v) ? Number(v) : null;
  };
  api.get('/rules', async (c) =>
    c.json({
      items: await svc.listRules(c.get('ctx'), { includeInactive: c.req.query('all') === 'true' }),
    }),
  );
  api.post('/rules', async (c) => c.json(await svc.createRule(c.get('ctx'), await body(c)), 201));
  api.put('/rules/:id', async (c) =>
    c.json(await svc.updateRule(c.get('ctx'), c.req.param('id'), ifMatch(c), await body(c))),
  );
  api.delete('/rules/:id', async (c) => {
    await svc.deactivateRule(c.get('ctx'), c.req.param('id'), ifMatch(c));
    return c.body(null, 204);
  });
  api.post('/rules/preview', async (c) =>
    c.json(await svc.previewRule(c.get('ctx'), await body(c))),
  );
  api.post('/rules/apply', async (c) => c.json(await svc.applyRules(c.get('ctx'))));

  // The morning run (spec §5.1): sync everything, rebuild bundles.
  api.post('/runs/morning', async (c) => {
    if (!jobs) return c.json(await svc.morningRun(c.get('ctx').db, connectors));
    const jobId = await jobs.enqueueMorningRun();
    return c.json({ queued: jobId != null, alreadyRunning: jobId == null }, 202);
  });

  api.all('*', () => problem(404, 'not_found', 'No such route'));
  return api;
}
