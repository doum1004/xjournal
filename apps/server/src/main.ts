import { createHubAuth } from '@xjournal/auth';
import { builtinConnectors } from '@xjournal/connectors';
import { connectPostgres } from '@xjournal/db';
import { osKeychain } from '@xjournal/secrets';
import * as svc from '@xjournal/services';
import { createApp } from './app';
import { loadConfig } from './config';
import { createBoss, type Jobs, startJobs } from './jobs';

const config = loadConfig();
const db = connectPostgres(config.databaseUrl);
const authDb = connectPostgres(config.databaseUrl, { role: 'hub_auth', max: 4 });
const auth = createHubAuth({
  authDb: authDb.db,
  baseURL: config.baseURL,
  secret: config.authSecret,
});

const log = (level: 'info' | 'warn' | 'error', msg: string, extra: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ level, time: new Date().toISOString(), msg, ...extra }));

const connectors: svc.ConnectorDeps = {
  registry: builtinConnectors(),
  secrets: osKeychain(),
  log: { info: (msg, data) => log('info', msg, data), warn: (msg, data) => log('warn', msg, data) },
};

// Direct report generation: the Claude API key lives in the same OS keychain.
const generate: svc.GenerateDeps = {
  secrets: connectors.secrets,
  ...(config.model ? { model: config.model } : {}),
};

// The job queue: the scheduled morning run and "sync now" (spec §5.1, docs/adr/0003).
const boss = createBoss(db, config.databaseUrl);
boss.on('error', (e) => log('error', 'job queue error', { error: String(e) }));
let jobs: Jobs | undefined;
try {
  const owner = await svc.localOwner(db.db);
  const ws = await svc.getWorkspace({ db: db.db, actor: owner });
  await boss.start();
  jobs = await startJobs(boss, {
    db: db.db,
    connectors,
    generate,
    timeZone: ws.timeZone,
    ...(config.morningCron ? { cron: config.morningCron } : {}),
    log,
  });
  log('info', 'morning run scheduled', {
    cron: config.morningCron ?? '0 7 * * *',
    tz: ws.timeZone,
  });
} catch (e) {
  // Not set up yet (`hub init`): serve the API anyway; the UI says what to do.
  log('warn', 'job queue not started', { error: String(e) });
}

const app = createApp({ config, db, auth, connectors, generate, ...(jobs ? { jobs } : {}) });

// Generous idle timeout: without the queue, "sync now" runs inside the request.
const server = Bun.serve({
  hostname: config.host,
  port: config.port,
  fetch: app.fetch,
  idleTimeout: 255,
});

log('info', 'hub listening', {
  url: `http://${server.hostname}:${server.port}`,
  mode: config.mode,
});
if (config.mode === 'local' && config.generated.localToken) {
  // Printed once to the local console only, so a dev run works without setup.
  log('info', 'generated a local token for this run; set HUB_LOCAL_TOKEN to keep it', {
    localToken: config.localToken,
  });
}

const shutdown = async () => {
  server.stop();
  await boss.stop({ graceful: true, timeout: 10_000 }).catch(() => {});
  await Promise.allSettled([db.close(), authDb.close()]);
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
