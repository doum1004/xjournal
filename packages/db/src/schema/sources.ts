import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  unique,
} from 'drizzle-orm/pg-core';
import { syncStatus, visibility } from './enums';
import { projects, tz, users, workspaces } from './identity';

// schema.md §4.

export const identities = pgTable(
  'identities',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id),
    userId: text('user_id')
      .notNull()
      .references(() => users.id),
    source: text('source').notNull(),
    accountKey: text('account_key').notNull(),
    aliases: text('aliases').array().notNull().default(sql`'{}'::text[]`),
  },
  (t) => [unique('identities_ws_source_account_key').on(t.workspaceId, t.source, t.accountKey)],
);

export const connectorAccounts = pgTable(
  'connector_accounts',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id),
    ownerUserId: text('owner_user_id')
      .notNull()
      .references(() => users.id),
    source: text('source').notNull(),
    displayName: text('display_name').notNull(),
    authType: text('auth_type').notNull(),
    secretRef: text('secret_ref'),
    scopes: text('scopes').array().notNull().default(sql`'{}'::text[]`),
    config: jsonb('config').notNull().default({}),
    status: syncStatus('status').notNull().default('ok'),
    createdAt: tz('created_at').notNull().defaultNow(),
    disconnectedAt: tz('disconnected_at'),
  },
  (t) => [
    check(
      'connector_accounts_auth_type_check',
      sql`${t.authType} in ('oauth', 'pat', 'app', 'webhook_secret', 'none')`,
    ),
  ],
);

export const projectSources = pgTable(
  'project_sources',
  {
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id),
    connectorAccountId: text('connector_account_id')
      .notNull()
      .references(() => connectorAccounts.id),
    workspaceId: text('workspace_id').notNull(),
    defaultVisibility: visibility('default_visibility').notNull().default('private'),
    addedBy: text('added_by')
      .notNull()
      .references(() => users.id),
    addedAt: tz('added_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.projectId, t.connectorAccountId] })],
);

export const syncStates = pgTable(
  'sync_states',
  {
    connectorAccountId: text('connector_account_id')
      .notNull()
      .references(() => connectorAccounts.id),
    stream: text('stream').notNull(),
    workspaceId: text('workspace_id').notNull(),
    cursor: jsonb('cursor'),
    lastSuccessAt: tz('last_success_at'),
    lastAttemptAt: tz('last_attempt_at'),
    lastError: text('last_error'),
    historyFloor: tz('history_floor'),
  },
  (t) => [primaryKey({ columns: [t.connectorAccountId, t.stream] })],
);

export const projectRules = pgTable(
  'project_rules',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id),
    priority: integer('priority').notNull(),
    match: jsonb('match').notNull(),
    version: integer('version').notNull(),
    active: boolean('active').notNull().default(true),
    createdBy: text('created_by')
      .notNull()
      .references(() => users.id),
    createdAt: tz('created_at').notNull().defaultNow(),
  },
  (t) => [index('project_rules_ws_active_priority_idx').on(t.workspaceId, t.active, t.priority)],
);
