import { sql } from 'drizzle-orm';
import { bigint, boolean, jsonb, pgTable, text } from 'drizzle-orm/pg-core';
import { sessions, tz, users } from './identity';

// Tables owned by Better Auth plugins (docs/adr/0001, 0002). The TS export names are the
// Better Auth model names; the SQL names follow the hub's snake_case convention. These
// tables are reached only through the `hub_auth` role (rls.sql), never by the service layer.

const textArray = (name: string) => text(name).array();

/**
 * Required by Better Auth's schema check, but always empty: sign-in is passkey-only, so there
 * are no linked provider accounts and no passwords (spec §11.5). RLS gives hub_app no access.
 */
export const accounts = pgTable('accounts', {
  id: text('id').primaryKey(),
  accountId: text('account_id').notNull(),
  providerId: text('provider_id').notNull(),
  userId: text('user_id')
    .notNull()
    .references(() => users.id),
  accessToken: text('access_token'),
  refreshToken: text('refresh_token'),
  idToken: text('id_token'),
  accessTokenExpiresAt: tz('access_token_expires_at'),
  refreshTokenExpiresAt: tz('refresh_token_expires_at'),
  scope: text('scope'),
  password: text('password'),
  createdAt: tz('created_at').notNull().defaultNow(),
  updatedAt: tz('updated_at').notNull().defaultNow(),
});

/** WebAuthn challenges and other short-lived values. */
export const verifications = pgTable('verifications', {
  id: text('id').primaryKey(),
  identifier: text('identifier').notNull(),
  value: text('value').notNull(),
  expiresAt: tz('expires_at').notNull(),
  createdAt: tz('created_at').notNull().defaultNow(),
  updatedAt: tz('updated_at').notNull().defaultNow(),
});

/** Signing keys for MCP OAuth access tokens (jwt plugin). Private keys are encrypted by the library. */
export const jwks = pgTable('jwks', {
  id: text('id').primaryKey(),
  publicKey: text('public_key').notNull(),
  privateKey: text('private_key').notNull(),
  createdAt: tz('created_at').notNull().defaultNow(),
  expiresAt: tz('expires_at'),
  alg: text('alg'),
  crv: text('crv'),
});

export const oauthClient = pgTable('oauth_clients', {
  id: text('id').primaryKey(),
  clientId: text('client_id').notNull().unique(),
  clientSecret: text('client_secret'),
  clientDiscoveryId: text('client_discovery_id'),
  disabled: boolean('disabled').default(false),
  skipConsent: boolean('skip_consent'),
  enableEndSession: boolean('enable_end_session'),
  subjectType: text('subject_type'),
  scopes: textArray('scopes'),
  clientCredentialsScopes: textArray('client_credentials_scopes').default(sql`'{}'::text[]`),
  userId: text('user_id').references(() => users.id),
  createdAt: tz('created_at'),
  updatedAt: tz('updated_at'),
  name: text('name'),
  uri: text('uri'),
  icon: text('icon'),
  contacts: textArray('contacts'),
  tos: text('tos'),
  policy: text('policy'),
  softwareId: text('software_id'),
  softwareVersion: text('software_version'),
  softwareStatement: text('software_statement'),
  redirectUris: textArray('redirect_uris').notNull(),
  postLogoutRedirectUris: textArray('post_logout_redirect_uris'),
  backchannelLogoutUri: text('backchannel_logout_uri'),
  backchannelLogoutSessionRequired: boolean('backchannel_logout_session_required'),
  tokenEndpointAuthMethod: text('token_endpoint_auth_method'),
  applicationType: text('application_type'),
  jwks: text('jwks'),
  jwksUri: text('jwks_uri'),
  grantTypes: textArray('grant_types'),
  responseTypes: textArray('response_types'),
  requirePKCE: boolean('require_pkce'),
  dpopBoundAccessTokens: boolean('dpop_bound_access_tokens').default(false),
  referenceId: text('reference_id'),
  metadata: jsonb('metadata'),
});

export const oauthResource = pgTable('oauth_resources', {
  id: text('id').primaryKey(),
  identifier: text('identifier').notNull().unique(),
  name: text('name').notNull(),
  accessTokenTtl: bigint('access_token_ttl', { mode: 'number' }),
  refreshTokenTtl: bigint('refresh_token_ttl', { mode: 'number' }),
  signingAlgorithm: text('signing_algorithm'),
  signingKeyId: text('signing_key_id'),
  allowedScopes: textArray('allowed_scopes'),
  customClaims: jsonb('custom_claims'),
  dpopBoundAccessTokensRequired: boolean('dpop_bound_access_tokens_required').default(false),
  disabled: boolean('disabled').default(false),
  createdAt: tz('created_at'),
  updatedAt: tz('updated_at'),
  policyVersion: bigint('policy_version', { mode: 'number' }).default(0),
  metadata: jsonb('metadata'),
});

export const oauthClientResource = pgTable('oauth_client_resources', {
  id: text('id').primaryKey(),
  clientId: text('client_id')
    .notNull()
    .references(() => oauthClient.clientId),
  resourceId: text('resource_id')
    .notNull()
    .references(() => oauthResource.identifier),
  metadata: jsonb('metadata'),
  createdAt: tz('created_at'),
});

export const oauthRefreshToken = pgTable('oauth_refresh_tokens', {
  id: text('id').primaryKey(),
  token: text('token').notNull().unique(),
  clientId: text('client_id')
    .notNull()
    .references(() => oauthClient.clientId),
  sessionId: text('session_id').references(() => sessions.id, { onDelete: 'set null' }),
  userId: text('user_id')
    .notNull()
    .references(() => users.id),
  referenceId: text('reference_id'),
  authorizationCodeId: text('authorization_code_id'),
  resources: textArray('resources'),
  requestedUserInfoClaims: textArray('requested_user_info_claims'),
  expiresAt: tz('expires_at'),
  createdAt: tz('created_at'),
  revoked: tz('revoked'),
  rotatedAt: tz('rotated_at'),
  rotationReplayResponse: text('rotation_replay_response'),
  rotationReplayExpiresAt: tz('rotation_replay_expires_at'),
  authTime: tz('auth_time'),
  confirmation: jsonb('confirmation'),
  scopes: textArray('scopes').notNull(),
});

export const oauthAccessToken = pgTable('oauth_access_tokens', {
  id: text('id').primaryKey(),
  token: text('token').unique(),
  clientId: text('client_id')
    .notNull()
    .references(() => oauthClient.clientId),
  sessionId: text('session_id').references(() => sessions.id, { onDelete: 'set null' }),
  userId: text('user_id').references(() => users.id),
  referenceId: text('reference_id'),
  authorizationCodeId: text('authorization_code_id'),
  resources: textArray('resources'),
  requestedUserInfoClaims: textArray('requested_user_info_claims'),
  refreshId: text('refresh_id').references(() => oauthRefreshToken.id),
  expiresAt: tz('expires_at'),
  createdAt: tz('created_at'),
  revoked: tz('revoked'),
  confirmation: jsonb('confirmation'),
  scopes: textArray('scopes').notNull(),
});

export const oauthConsent = pgTable('oauth_consents', {
  id: text('id').primaryKey(),
  clientId: text('client_id')
    .notNull()
    .references(() => oauthClient.clientId),
  userId: text('user_id').references(() => users.id),
  referenceId: text('reference_id'),
  resources: textArray('resources'),
  requestedUserInfoClaims: textArray('requested_user_info_claims'),
  scopes: textArray('scopes').notNull(),
  createdAt: tz('created_at'),
  updatedAt: tz('updated_at'),
});

export const oauthClientAssertion = pgTable('oauth_client_assertions', {
  id: text('id').primaryKey(),
  expiresAt: tz('expires_at').notNull(),
});
