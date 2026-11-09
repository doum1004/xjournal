import { mcp } from '@better-auth/mcp';
import { passkey } from '@better-auth/passkey';
import { newId } from '@xjournal/core';
import { authRepo, type HubDb, schema } from '@xjournal/db';
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { APIError, createAuthMiddleware } from 'better-auth/api';
import { jwt } from 'better-auth/plugins';
import { verifyTicket } from './tokens';

export interface HubAuthOptions {
  /**
   * Database for Better Auth. Its connections must run as `hub_auth`
   * (`connectPostgres(url, { role: 'hub_auth' })`), docs/adr/0001.
   */
  authDb: HubDb;
  /** Public origin of the hub, e.g. 'https://hub.example.com' or 'http://localhost:7420'. */
  baseURL: string;
  secret: string;
  /** WebAuthn relying party ID. Defaults to the baseURL host. Passkeys are bound to it. */
  rpID?: string;
  rpName?: string;
  /** Canonical MCP resource URL; OAuth access tokens are audience-bound to it. */
  mcpResource?: string;
}

// Better Auth's models, mapped onto the hub's tables (schema.md §3).
const authSchema = {
  users: schema.users,
  sessions: schema.sessions,
  passkeys: schema.passkeys,
  accounts: schema.accounts,
  verifications: schema.verifications,
  jwks: schema.jwks,
  oauthClient: schema.oauthClient,
  oauthResource: schema.oauthResource,
  oauthClientResource: schema.oauthClientResource,
  oauthRefreshToken: schema.oauthRefreshToken,
  oauthAccessToken: schema.oauthAccessToken,
  oauthConsent: schema.oauthConsent,
  oauthClientAssertion: schema.oauthClientAssertion,
};

export function createHubAuth(opts: HubAuthOptions) {
  const db = opts.authDb;
  const rpID = opts.rpID ?? new URL(opts.baseURL).hostname;
  const mcpResource = opts.mcpResource ?? new URL('/mcp', opts.baseURL).toString();

  return betterAuth({
    baseURL: opts.baseURL,
    basePath: '/api/auth',
    secret: opts.secret,
    database: drizzleAdapter(db, { provider: 'pg', schema: authSchema }),
    advanced: { database: { generateId: () => newId() } },
    // No passwords, no email sign-in (spec §11.5).
    emailAndPassword: { enabled: false },
    user: { modelName: 'users', fields: { name: 'displayName' } },
    session: { modelName: 'sessions' },
    account: { modelName: 'accounts' },
    verification: { modelName: 'verifications' },
    rateLimit: { enabled: true, window: 60, max: 30 },
    plugins: [
      passkey({
        rpID,
        rpName: opts.rpName ?? 'xjournal',
        origin: new URL(opts.baseURL).origin,
        schema: {
          passkey: {
            modelName: 'passkeys',
            fields: { name: 'deviceLabel', credentialID: 'credentialId' },
          },
        },
        authenticatorSelection: { residentKey: 'required', userVerification: 'preferred' },
        registration: {
          // Passkey-first registration through an invite: no session yet. The `context` is the
          // ticket from POST /auth/invites/redeem, proving the link and code were checked.
          requireSession: false,
          resolveUser: async ({ context }) => {
            const ticket = context ? verifyTicket(opts.secret, context) : null;
            if (!ticket)
              throw new APIError('UNAUTHORIZED', {
                message: 'invite required',
                code: 'invite_required',
              });
            const invite = await authRepo.findInviteById(db, ticket.inviteId);
            if (!invite || invite.usedAt || invite.revokedAt || invite.expiresAt <= new Date()) {
              throw new APIError('GONE', {
                message: 'invite no longer valid',
                code: 'invite_expired',
              });
            }
            return { id: ticket.userId, name: invite.displayName, displayName: invite.displayName };
          },
          // Runs before Better Auth stores the passkey: consume the invite, create the user and
          // membership. Throwing here aborts the registration.
          afterVerification: async ({ context, user }) => {
            const ticket = context ? verifyTicket(opts.secret, context) : null;
            if (!ticket || ticket.userId !== user.id) {
              throw new APIError('UNAUTHORIZED', {
                message: 'invite required',
                code: 'invite_required',
              });
            }
            const result = await authRepo.consumeInvite(db, {
              inviteId: ticket.inviteId,
              userId: ticket.userId,
              displayName: user.displayName ?? user.name,
            });
            if (!result.ok) {
              const status = result.reason === 'already_used' ? 'CONFLICT' : 'GONE';
              throw new APIError(status, {
                message: `invite ${result.reason}`,
                code: result.reason,
              });
            }
            return { userId: ticket.userId };
          },
        },
        authentication: {
          // Device approval (spec §11.5): a pending, rejected or revoked passkey never gets a session.
          afterVerification: async ({ clientData }) => {
            const status = await authRepo.passkeyStatusForSignIn(db, clientData.id);
            if (status !== 'approved') {
              throw new APIError('FORBIDDEN', {
                message:
                  status === 'pending'
                    ? 'This device is waiting for approval.'
                    : 'This device is not allowed.',
                code: status === 'pending' ? 'device_pending' : 'device_not_allowed',
              });
            }
          },
        },
      }),
      // Signing keys for MCP OAuth access tokens (JWTs, verified against /api/auth/jwks).
      jwt(),
      // OAuth 2.1 + PKCE authorization server for remote MCP clients (spec §11.5, api.md §5).
      mcp({
        resource: mcpResource,
        loginPage: '/sign-in',
        consentPage: '/consent',
        allowDynamicClientRegistration: true,
        allowUnauthenticatedClientRegistration: true,
        // MCP clients (Claude Code, Cursor) register loopback callbacks without an
        // application_type; treat those as native clients instead of rejecting them.
        clientRegistrationDefaultApplicationType: 'infer',
      }),
    ],
    hooks: {
      after: createAuthMiddleware(async (ctx) => {
        // Better Auth has just stored the passkey: link it to its invite and set its approval
        // state from the project's `require_device_approval`.
        if (ctx.path !== '/passkey/verify-registration') return;
        if (ctx.context.returned instanceof Error) return;
        const credentialId = (ctx.body as { response?: { id?: string } } | undefined)?.response?.id;
        if (credentialId) await authRepo.finishInvitePasskey(db, credentialId);
      }),
    },
  });
}

export type HubAuth = ReturnType<typeof createHubAuth>;
