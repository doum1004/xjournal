import { randomBytes } from 'node:crypto';
import { z } from 'zod';

// Configuration comes from the environment only (spec §11.4 rule 2).
const Env = z.object({
  DATABASE_URL: z.string().min(1),
  HUB_MODE: z.enum(['local', 'hosted']).default('local'),
  /** Local mode binds to loopback only (spec §11.3). */
  HUB_HOST: z.string().default('127.0.0.1'),
  HUB_PORT: z.coerce.number().int().default(7420),
  HUB_BASE_URL: z.url().optional(),
  /** Local mode: the per-install token for the UI and HTTP MCP (spec §11.3). */
  HUB_LOCAL_TOKEN: z.string().min(24).optional(),
  BETTER_AUTH_SECRET: z.string().min(32).optional(),
});

export interface Config {
  databaseUrl: string;
  mode: 'local' | 'hosted';
  host: string;
  port: number;
  baseURL: string;
  localToken: string;
  authSecret: string;
  /** True when a secret was generated because none was configured (local dev only). */
  generated: { localToken: boolean; authSecret: boolean };
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const e = Env.parse(env);
  if (e.HUB_MODE === 'hosted' && (!e.BETTER_AUTH_SECRET || !e.HUB_BASE_URL)) {
    throw new Error('Hosted mode needs BETTER_AUTH_SECRET and HUB_BASE_URL.');
  }
  const random = () => randomBytes(32).toString('base64url');
  return {
    databaseUrl: e.DATABASE_URL,
    mode: e.HUB_MODE,
    host: e.HUB_HOST,
    port: e.HUB_PORT,
    baseURL: e.HUB_BASE_URL ?? `http://localhost:${e.HUB_PORT}`,
    localToken: e.HUB_LOCAL_TOKEN ?? random(),
    authSecret: e.BETTER_AUTH_SECRET ?? random(),
    generated: { localToken: !e.HUB_LOCAL_TOKEN, authSecret: !e.BETTER_AUTH_SECRET },
  };
}
