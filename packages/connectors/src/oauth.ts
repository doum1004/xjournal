import { z } from 'zod';
import { requestJson } from './http';
import { ConnectorAuthError, type SyncInput } from './sdk';

// OAuth credentials for the Google Calendar and Zoom connectors (spec §8.7, local mode: the
// user registers their own OAuth app). The secret store holds either
//   - a bare access token (fine for a test; it expires within the hour), or
//   - JSON: { client_id, client_secret, refresh_token } for a user-level app, or, for Zoom,
//     { client_id, client_secret, account_id } for a Server-to-Server app.
// The connector refreshes the access token when it is missing or about to expire and stores the
// updated JSON at once (`SyncInput.saveSecret`), so the next page and the next sync reuse it.
// Zoom replaces the refresh token on every refresh, so the new one must be kept even if the
// rest of the page then fails.

const zOAuthSecret = z.object({
  client_id: z.string().min(1),
  client_secret: z.string().min(1),
  refresh_token: z.string().min(1).optional(),
  account_id: z.string().min(1).optional(),
  access_token: z.string().min(1).optional(),
  /** When `access_token` expires, ISO 8601. */
  expires_at: z.string().optional(),
});
export type OAuthSecret = z.infer<typeof zOAuthSecret>;

export interface OAuthProvider {
  name: string;
  tokenUrl: string;
  /** How the client authenticates at the token endpoint. */
  clientAuth: 'body' | 'basic';
  /** Whether `account_id` (Zoom Server-to-Server) is accepted. */
  accountCredentials?: boolean;
  /** The consent page, for signing in from the CLI (`hub connector add … --oauth`). */
  authUrl?: string;
  scopes?: string[];
  /** Extra parameters for the consent page, e.g. Google's access_type=offline. */
  authParams?: Record<string, string>;
}

export interface OAuthClient {
  client_id: string;
  client_secret: string;
}

/**
 * The client ID and secret from an OAuth client file: Google's download
 * ({"installed": {...}} or {"web": {...}}) or a plain {client_id, client_secret}.
 */
export function parseOAuthClient(json: string): OAuthClient {
  const raw = JSON.parse(json) as Record<string, unknown>;
  const inner = (raw.installed ?? raw.web ?? raw) as Partial<OAuthClient>;
  if (!inner.client_id || !inner.client_secret) {
    throw new Error('The OAuth client file needs client_id and client_secret');
  }
  return { client_id: inner.client_id, client_secret: inner.client_secret };
}

/** The consent page URL, with PKCE (S256). */
export function authorizeUrl(
  provider: OAuthProvider,
  client: OAuthClient,
  redirectUri: string,
  state: string,
  challenge: string,
): string {
  if (!provider.authUrl) throw new Error(`${provider.name}: no sign-in page`);
  const q = new URLSearchParams({
    response_type: 'code',
    client_id: client.client_id,
    redirect_uri: redirectUri,
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    ...(provider.scopes?.length ? { scope: provider.scopes.join(' ') } : {}),
    ...provider.authParams,
  });
  return `${provider.authUrl}?${q}`;
}

/** PKCE: a random verifier and its S256 challenge. */
export async function pkcePair(): Promise<{ verifier: string; challenge: string }> {
  const b64url = (b: Uint8Array) =>
    Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return { verifier, challenge: b64url(new Uint8Array(digest)) };
}

/** Trade the consent page's code for tokens; returns the secret to store. */
export async function exchangeCode(
  input: Pick<SyncInput<unknown>, 'fetch' | 'now'>,
  provider: OAuthProvider,
  client: OAuthClient,
  code: string,
  redirectUri: string,
  verifier: string,
): Promise<string> {
  const form = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    code_verifier: verifier,
  });
  const headers: Record<string, string> = {};
  if (provider.clientAuth === 'basic') {
    headers.Authorization = `Basic ${Buffer.from(`${client.client_id}:${client.client_secret}`).toString('base64')}`;
  } else {
    form.set('client_id', client.client_id);
    form.set('client_secret', client.client_secret);
  }
  const res = await requestJson<{
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
  }>(input, provider.tokenUrl, { method: 'POST', headers, body: form, allow: [400] });
  if (!res?.access_token || !res.refresh_token) {
    throw new Error(
      `${provider.name}: the sign-in returned no refresh token (is the app allowed offline access?)`,
    );
  }
  const secret: OAuthSecret = {
    ...client,
    refresh_token: res.refresh_token,
    access_token: res.access_token,
    expires_at: new Date(input.now.getTime() + (res.expires_in ?? 3600) * 1000).toISOString(),
  };
  return JSON.stringify(secret);
}

/** Refresh this long before the token expires. */
const MARGIN_MS = 5 * 60_000;

export function parseOAuthSecret(secret: string): OAuthSecret | string {
  const s = secret.trim();
  if (!s.startsWith('{')) return s;
  let raw: unknown;
  try {
    raw = JSON.parse(s);
  } catch {
    throw new ConnectorAuthError('The stored credential is not valid JSON; reconnect');
  }
  const parsed = zOAuthSecret.safeParse(raw);
  if (!parsed.success) {
    throw new ConnectorAuthError(
      'The stored credential needs client_id, client_secret and a refresh_token (or account_id); reconnect',
    );
  }
  return parsed.data;
}

export async function oauthToken(
  input: Pick<SyncInput<unknown>, 'secret' | 'now' | 'fetch' | 'signal' | 'saveSecret'>,
  provider: OAuthProvider,
): Promise<string> {
  if (!input.secret) throw new ConnectorAuthError(`${provider.name}: no credential; reconnect`);
  const s = parseOAuthSecret(input.secret);
  if (typeof s === 'string') return s;

  const expires = s.expires_at ? Date.parse(s.expires_at) : 0;
  if (s.access_token && expires - MARGIN_MS > input.now.getTime()) return s.access_token;

  const form = new URLSearchParams();
  if (s.refresh_token) {
    form.set('grant_type', 'refresh_token');
    form.set('refresh_token', s.refresh_token);
  } else if (s.account_id && provider.accountCredentials) {
    form.set('grant_type', 'account_credentials');
    form.set('account_id', s.account_id);
  } else {
    throw new ConnectorAuthError(
      `${provider.name}: the credential has no refresh_token; reconnect`,
    );
  }
  const headers: Record<string, string> = {};
  if (provider.clientAuth === 'basic') {
    headers.Authorization = `Basic ${Buffer.from(`${s.client_id}:${s.client_secret}`).toString('base64')}`;
  } else {
    form.set('client_id', s.client_id);
    form.set('client_secret', s.client_secret);
  }
  const res = await requestJson<{
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
  }>(input, provider.tokenUrl, { method: 'POST', headers, body: form, allow: [400] });
  if (!res?.access_token) {
    // 400 invalid_grant: the refresh token was revoked or already used.
    throw new ConnectorAuthError(`${provider.name}: the token refresh was refused; reconnect`);
  }
  const next: OAuthSecret = {
    ...s,
    access_token: res.access_token,
    expires_at: new Date(input.now.getTime() + (res.expires_in ?? 3600) * 1000).toISOString(),
    ...(res.refresh_token ? { refresh_token: res.refresh_token } : {}),
  };
  await input.saveSecret?.(JSON.stringify(next));
  return res.access_token;
}
