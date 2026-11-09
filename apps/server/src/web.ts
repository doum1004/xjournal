import { existsSync, statSync } from 'node:fs';
import { join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// Serves the built web UI (apps/web/dist) from the hub process (spec §11.1, §16): real files
// as they are, and index.html for every other GET, so client-side routes survive a reload.

export const defaultWebDist = fileURLToPath(new URL('../../web/dist', import.meta.url));

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
  '.map': 'application/json',
};

const typeOf = (path: string) =>
  TYPES[path.slice(path.lastIndexOf('.'))] ?? 'application/octet-stream';

export function webHandler(distDir: string = defaultWebDist) {
  const root = resolve(distDir);
  const index = join(root, 'index.html');

  return async (pathname: string): Promise<Response | null> => {
    if (!existsSync(index)) return null;
    // Resolve inside the dist folder only; anything that escapes it falls back to index.html.
    const decoded = (() => {
      try {
        return decodeURIComponent(pathname);
      } catch {
        return '/';
      }
    })();
    const candidate = resolve(root, `.${normalize(decoded)}`);
    const inside = candidate === root || candidate.startsWith(root + sep);
    if (inside && candidate !== root && existsSync(candidate) && statSync(candidate).isFile()) {
      const immutable = candidate.startsWith(join(root, 'assets') + sep);
      return new Response(Bun.file(candidate), {
        headers: {
          'content-type': typeOf(candidate),
          // Vite names assets by content hash, so they can be cached for good.
          'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
        },
      });
    }
    // A missing asset is a real 404; anything else is a client-side route.
    if (decoded.startsWith('/assets/')) return new Response('Not found', { status: 404 });
    return new Response(Bun.file(index), {
      headers: { 'content-type': TYPES['.html'] as string, 'cache-control': 'no-cache' },
    });
  };
}
