import { ConnectorAuthError, ConnectorRateLimitError, type SyncInput } from './sdk';

// JSON over HTTP for the OAuth connectors (Slack, Google Calendar). Maps refused
// credentials to ConnectorAuthError and throttling to ConnectorRateLimitError, like the
// Atlassian client does.

export interface JsonRequest {
  method?: 'GET' | 'POST';
  token?: string;
  headers?: Record<string, string>;
  /** Sent as JSON; a URLSearchParams body is sent as a form. */
  body?: unknown;
  /** Statuses returned as `null` instead of thrown, e.g. 404 for "no summary". */
  allow?: number[];
}

export async function requestJson<T>(
  input: Pick<SyncInput<unknown>, 'fetch' | 'signal'>,
  url: string,
  req: JsonRequest = {},
): Promise<T | null> {
  const method = req.method ?? (req.body === undefined ? 'GET' : 'POST');
  const headers: Record<string, string> = {
    Accept: 'application/json',
    'User-Agent': 'xjournal',
    ...req.headers,
  };
  if (req.token) headers.Authorization = `Bearer ${req.token}`;
  let body: string | undefined;
  if (req.body instanceof URLSearchParams) {
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
    body = req.body.toString();
  } else if (req.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(req.body);
  }
  const res = await input.fetch(url, {
    method,
    headers,
    ...(body !== undefined ? { body } : {}),
    ...(input.signal ? { signal: input.signal } : {}),
  });
  if (res.ok) return (await res.json()) as T;
  if (req.allow?.includes(res.status)) return null;
  const text = (await res.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 200);
  const where = `${method} ${new URL(url).pathname}`;
  if (res.status === 401 || res.status === 403) {
    throw new ConnectorAuthError(`${where}: ${res.status} ${text}`);
  }
  if (res.status === 429 || res.status === 503) throw rateLimited(where, res);
  throw new HttpError(`${where}: ${res.status} ${text}`, res.status, text);
}

/** Any other failed request, with the status and the start of the body. */
export class HttpError extends Error {
  override name = 'HttpError';
  constructor(
    message: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(message);
  }
}

export function rateLimited(where: string, res: Response): ConnectorRateLimitError {
  const after = Number(res.headers.get('retry-after'));
  return new ConnectorRateLimitError(
    `${where}: ${res.status} rate limited`,
    after ? new Date(Date.now() + after * 1000) : undefined,
  );
}
