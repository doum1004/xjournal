/** A tiny cookie-keeping client over an in-process fetch handler (no network). */
export class Browser {
  private jar = new Map<string, string>();
  constructor(
    private readonly fetchFn: (req: Request) => Response | Promise<Response>,
    readonly origin: string,
  ) {}

  async request(path: string, init: RequestInit & { json?: unknown } = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    if (this.jar.size) headers.set('cookie', [...this.jar].map(([k, v]) => `${k}=${v}`).join('; '));
    headers.set('origin', this.origin);
    let body = init.body;
    if (init.json !== undefined) {
      headers.set('content-type', 'application/json');
      body = JSON.stringify(init.json);
    }
    const res = await this.fetchFn(
      new Request(new URL(path, this.origin), { ...init, headers, body, redirect: 'manual' }),
    );
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(';');
      const eq = pair?.indexOf('=') ?? -1;
      if (!pair || eq < 0) continue;
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      if (/max-age=0/i.test(c) || value === '') this.jar.delete(name);
      else this.jar.set(name, value);
    }
    return res;
  }

  get(path: string, init: RequestInit = {}) {
    return this.request(path, { ...init, method: 'GET' });
  }

  post(path: string, json?: unknown, init: RequestInit = {}) {
    return this.request(path, { ...init, method: 'POST', json });
  }
}
