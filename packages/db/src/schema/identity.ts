import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  date,
  index,
  jsonb,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  unique,
} from 'drizzle-orm/pg-core';
import { deviceStatus, inviteKind, memberRole, trustDomain, visibility } from './enums';

// schema.md §3. `users`, `sessions` and `passkeys` are shared with Better Auth: the hub's
// columns from schema.md plus the columns the library requires (docs/adr/0001).
// The TS property names are what Better Auth's `fields` mapping refers to.

export const tz = (name: string) => timestamp(name, { withTimezone: true });

export const users = pgTable('users', {
  id: text('id').primaryKey(),
  displayName: text('display_name').notNull(),
  email: text('email').unique(), // reference only; never used for sign-in
  // Required by Better Auth; unused by the hub.
  emailVerified: boolean('email_verified').notNull().default(false),
  image: text('image'),
  createdAt: tz('created_at').notNull().defaultNow(),
  updatedAt: tz('updated_at').notNull().defaultNow(),
  disabledAt: tz('disabled_at'),
});

export const workspaces = pgTable('workspaces', {
  id: text('id').primaryKey(),
  domain: trustDomain('domain').notNull(),
  name: text('name').notNull(),
  ownerUserId: text('owner_user_id')
    .notNull()
    .references(() => users.id),
  timeZone: text('time_zone').notNull(),
  weekStart: smallint('week_start').notNull().default(1),
  biweeklyAnchor: date('biweekly_anchor').notNull().default('2024-01-01'),
  settings: jsonb('settings').notNull().default({}),
  createdAt: tz('created_at').notNull().defaultNow(),
});

export const projects = pgTable(
  'projects',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id),
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    timeZone: text('time_zone'),
    defaultNoteVisibility: visibility('default_note_visibility').notNull().default('private'),
    requireDeviceApproval: boolean('require_device_approval').notNull().default(true),
    createdAt: tz('created_at').notNull().defaultNow(),
    archivedAt: tz('archived_at'),
  },
  (t) => [unique('projects_workspace_slug_key').on(t.workspaceId, t.slug)],
);

export const projectMembers = pgTable(
  'project_members',
  {
    workspaceId: text('workspace_id').notNull(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id),
    userId: text('user_id')
      .notNull()
      .references(() => users.id),
    role: memberRole('role').notNull(),
    invitedBy: text('invited_by').references(() => users.id),
    joinedAt: tz('joined_at').notNull().defaultNow(),
    leftAt: tz('left_at'),
  },
  (t) => [
    primaryKey({ columns: [t.projectId, t.userId] }),
    index('project_members_ws_user_idx')
      .on(t.workspaceId, t.userId)
      .where(sql`${t.leftAt} is null`),
  ],
);

export const invites = pgTable('invites', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id').notNull(),
  projectId: text('project_id')
    .notNull()
    .references(() => projects.id),
  kind: inviteKind('kind').notNull(),
  role: memberRole('role').notNull(),
  forUserId: text('for_user_id').references(() => users.id),
  displayName: text('display_name').notNull(),
  tokenHash: text('token_hash').notNull().unique(),
  codeHash: text('code_hash').notNull(),
  failedAttempts: smallint('failed_attempts').notNull().default(0),
  createdBy: text('created_by')
    .notNull()
    .references(() => users.id),
  createdAt: tz('created_at').notNull().defaultNow(),
  expiresAt: tz('expires_at').notNull(),
  usedAt: tz('used_at'),
  usedByUserId: text('used_by_user_id').references(() => users.id),
  revokedAt: tz('revoked_at'),
});

export const passkeys = pgTable('passkeys', {
  id: text('id').primaryKey(),
  userId: text('user_id')
    .notNull()
    .references(() => users.id),
  credentialId: text('credential_id').notNull().unique(),
  publicKey: text('public_key').notNull(),
  counter: bigint('counter', { mode: 'number' }).notNull().default(0),
  deviceLabel: text('device_label'),
  // WebAuthn metadata stored by Better Auth.
  deviceType: text('device_type').notNull().default('singleDevice'),
  backedUp: boolean('backed_up').notNull().default(false),
  transports: text('transports'),
  aaguid: text('aaguid'),
  // Hub approval state (spec §11.5).
  status: deviceStatus('status').notNull().default('pending'),
  approvedBy: text('approved_by').references(() => users.id),
  approvedAt: tz('approved_at'),
  createdViaInviteId: text('created_via_invite_id').references(() => invites.id),
  createdAt: tz('created_at').notNull().defaultNow(),
  lastUsedAt: tz('last_used_at'),
  revokedAt: tz('revoked_at'),
});

export const sessions = pgTable('sessions', {
  id: text('id').primaryKey(),
  userId: text('user_id')
    .notNull()
    .references(() => users.id),
  // Better Auth stores the session token itself, not a hash (docs/adr/0001).
  token: text('token').notNull().unique(),
  passkeyId: text('passkey_id').references(() => passkeys.id),
  createdAt: tz('created_at').notNull().defaultNow(),
  updatedAt: tz('updated_at').notNull().defaultNow(),
  expiresAt: tz('expires_at').notNull(),
  lastSeenAt: tz('last_seen_at'),
  revokedAt: tz('revoked_at'),
  userAgent: text('user_agent'),
  ipAddress: text('ip_address'),
});

export const accessTokens = pgTable(
  'access_tokens',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id),
    kind: text('kind').notNull(),
    clientName: text('client_name'),
    tokenHash: text('token_hash').notNull().unique(),
    scopes: text('scopes').array().notNull(),
    projectIds: text('project_ids').array(),
    createdAt: tz('created_at').notNull().defaultNow(),
    expiresAt: tz('expires_at'),
    lastUsedAt: tz('last_used_at'),
    revokedAt: tz('revoked_at'),
  },
  (t) => [check('access_tokens_kind_check', sql`${t.kind} in ('pat', 'oauth')`)],
);
