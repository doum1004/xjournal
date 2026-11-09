import { z } from 'zod';
import { ConnectorAuthError, ConnectorRateLimitError, type SyncInput } from './sdk';

// Shared by the Jira and Confluence Server/Data Center connectors (spec §8.7: personal access
// tokens). With `auth: 'basic'` the token is sent as `login:token` (Server/DC API tokens);
// otherwise as a Bearer personal access token.

export const zAtlassianBase = z.object({
  /** e.g. https://jira.example.com */
  baseUrl: z
    .url()
    .refine((u) => u.startsWith('https://') || u.startsWith('http://localhost'), 'use https')
    .transform((u) => u.replace(/\/+$/, '')),
  /** Your username there: used for "is this mine?" and for basic auth. */
  login: z.string().trim().min(1),
  auth: z.enum(['bearer', 'basic']).default('bearer'),
});
export type AtlassianBase = z.infer<typeof zAtlassianBase>;

export const hostOf = (baseUrl: string) => new URL(baseUrl).host.toLowerCase();

export class AtlassianHttp {
  constructor(private readonly input: SyncInput<AtlassianBase>) {}

  async request<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    const { config, secret } = this.input;
    const headers: Record<string, string> = {
      Accept: 'application/json',
      'User-Agent': 'xjournal',
    };
    if (secret) {
      headers.Authorization =
        config.auth === 'basic'
          ? `Basic ${Buffer.from(`${config.login}:${secret}`).toString('base64')}`
          : `Bearer ${secret}`;
    }
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const url = config.baseUrl + path;
    const res = await this.input.fetch(url, {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      ...(this.input.signal ? { signal: this.input.signal } : {}),
    });
    if (res.ok) return (await res.json()) as T;
    const text = (await res.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 200);
    const where = `${method} ${new URL(url).pathname}`;
    if (res.status === 401 || res.status === 403) {
      throw new ConnectorAuthError(`${where}: ${res.status} ${text}`);
    }
    if (res.status === 429 || res.status === 503) {
      const after = Number(res.headers.get('retry-after'));
      throw new ConnectorRateLimitError(
        `${where}: ${res.status} rate limited`,
        after ? new Date(Date.now() + after * 1000) : undefined,
      );
    }
    throw new Error(`${where}: ${res.status} ${text}`);
  }
}

export const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
export const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();

/** The day before `date` (YYYY-MM-DD): JQL and CQL dates are in the user's profile time zone. */
export function dayBefore(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

/** Jira and Confluence timestamps like 2026-11-05T10:00:00.000+0000 → ISO 8601. */
export function isoOf(ts: string): string {
  const d = new Date(ts.replace(/([+-]\d{2})(\d{2})$/, '$1:$2'));
  if (Number.isNaN(d.getTime())) throw new Error(`Unreadable timestamp: ${ts}`);
  return d.toISOString();
}
