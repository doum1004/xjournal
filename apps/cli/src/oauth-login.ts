import {
  authorizeUrl,
  exchangeCode,
  type OAuthProvider,
  parseOAuthClient,
  pkcePair,
} from '@xjournal/connectors';

// Sign in to an OAuth source from the CLI (spec §8.7, local mode: the user's own OAuth app).
// Opens the provider's consent page, receives the code on a loopback redirect
// (http://localhost:<port>/callback, registered in the app's settings) and returns the
// credential JSON for the secret store. Nothing is printed but the consent URL.

const TIMEOUT_MS = 5 * 60_000;

export async function oauthLogin(
  provider: OAuthProvider,
  clientFile: string,
  port: number,
): Promise<string> {
  const client = parseOAuthClient(await Bun.file(clientFile).text());
  const redirectUri = `http://localhost:${port}/callback`;
  const state = crypto.randomUUID();
  const { verifier, challenge } = await pkcePair();

  const code = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      server.stop(true);
      reject(new Error('Timed out waiting for the sign-in'));
    }, TIMEOUT_MS);
    const finish = (fn: () => void) => {
      clearTimeout(timer);
      // Let the response reach the browser before closing.
      setTimeout(() => server.stop(true), 100);
      fn();
    };
    const page = (msg: string, status = 200) =>
      new Response(`<!doctype html><title>xjournal</title><p>${msg}</p>`, {
        status,
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      });
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port,
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname !== '/callback') return new Response('Not found', { status: 404 });
        if (url.searchParams.get('state') !== state) return page('Unexpected sign-in.', 400);
        const error = url.searchParams.get('error');
        if (error) {
          finish(() => reject(new Error(`The sign-in was refused: ${error}`)));
          return page('Sign-in refused. You can close this tab.', 400);
        }
        const c = url.searchParams.get('code');
        if (!c) return page('No code in the redirect.', 400);
        finish(() => resolve(c));
        return page('Signed in. You can close this tab and go back to the terminal.');
      },
    });
    const url = authorizeUrl(provider, client, redirectUri, state, challenge);
    console.log(`Sign in to ${provider.name} in your browser:\n  ${url}`);
    openBrowser(url);
  });

  return exchangeCode({ fetch, now: new Date() }, provider, client, code, redirectUri, verifier);
}

function openBrowser(url: string): void {
  const cmd =
    process.platform === 'win32'
      ? ['rundll32', 'url.dll,FileProtocolHandler', url]
      : process.platform === 'darwin'
        ? ['open', url]
        : ['xdg-open', url];
  try {
    Bun.spawn(cmd, { stdout: 'ignore', stderr: 'ignore' });
  } catch {
    // The URL is printed; the user can open it.
  }
}
