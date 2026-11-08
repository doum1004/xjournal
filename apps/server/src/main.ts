import { createHubAuth } from '@xjournal/auth';
import { connectPostgres } from '@xjournal/db';
import { createApp } from './app';
import { loadConfig } from './config';

const config = loadConfig();
const db = connectPostgres(config.databaseUrl);
const authDb = connectPostgres(config.databaseUrl, { role: 'hub_auth', max: 4 });
const auth = createHubAuth({
  authDb: authDb.db,
  baseURL: config.baseURL,
  secret: config.authSecret,
});
const app = createApp({ config, db, auth });

const server = Bun.serve({ hostname: config.host, port: config.port, fetch: app.fetch });

const log = (msg: string, extra: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ level: 'info', time: new Date().toISOString(), msg, ...extra }));

log('hub listening', { url: `http://${server.hostname}:${server.port}`, mode: config.mode });
if (config.mode === 'local' && config.generated.localToken) {
  // Printed once to the local console only, so a dev run works without setup.
  log('generated a local token for this run; set HUB_LOCAL_TOKEN to keep it', {
    localToken: config.localToken,
  });
}

const shutdown = async () => {
  server.stop();
  await Promise.allSettled([db.close(), authDb.close()]);
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
