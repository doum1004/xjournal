import { type SQL, sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  boolean,
  customType,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  real,
  text,
  unique,
} from 'drizzle-orm/pg-core';
import {
  inputTier,
  noteKind,
  recordKind,
  revisionKind,
  routedBy,
  routingStatus,
  visibility,
} from './enums';
import { projects, tz, users, workspaces } from './identity';
import { connectorAccounts, identities } from './sources';

// schema.md §5. `record_embeddings` is deferred to M5: its vector size follows the
// embedding model, which isn't chosen yet (plan.md §3).

const tsvector = customType<{ data: string }>({ dataType: () => 'tsvector' });

export const records = pgTable(
  'records',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id),
    source: text('source').notNull(),
    externalId: text('external_id').notNull(),
    kind: recordKind('kind').notNull(),
    tier: inputTier('tier').notNull(),
    connectorAccountId: text('connector_account_id').references(() => connectorAccounts.id),
    // people
    ownerUserId: text('owner_user_id')
      .notNull()
      .references(() => users.id),
    actorIdentityId: text('actor_identity_id').references(() => identities.id),
    isMine: boolean('is_mine').notNull(),
    // time (spec §3.4)
    eventTime: tz('event_time').notNull(),
    capturedAt: tz('captured_at').notNull(),
    enteredAt: tz('entered_at'),
    applicableDate: date('applicable_date').notNull(),
    // routing (spec §3.6, §8.4)
    projectId: text('project_id').references(() => projects.id),
    routingStatus: routingStatus('routing_status').notNull(),
    routedBy: routedBy('routed_by').notNull(),
    routingConfidence: real('routing_confidence'),
    noteKind: noteKind('note_kind'),
    parentRecordId: text('parent_record_id').references((): AnyPgColumn => records.id),
    // access (spec §9.3)
    visibility: visibility('visibility').notNull(),
    // content (current revision, denormalized)
    currentRevisionId: text('current_revision_id').notNull(),
    title: text('title').notNull(),
    url: text('url'),
    summary: text('summary'),
    searchTsv: tsvector('search_tsv').generatedAlwaysAs(
      (): SQL =>
        sql`to_tsvector('simple'::regconfig, coalesce(${records.title}, '') || ' ' || coalesce(${records.summary}, ''))`,
    ),
    hiddenAt: tz('hidden_at'),
    hiddenBy: text('hidden_by').references(() => users.id),
  },
  (t) => [
    unique('records_ws_source_external_key').on(t.workspaceId, t.source, t.externalId),
    index('records_ws_project_date_idx').on(t.workspaceId, t.projectId, t.applicableDate),
    index('records_inbox_idx')
      .on(t.workspaceId, t.projectId)
      .where(sql`${t.routingStatus} = 'needs_review' or ${t.projectId} is null`),
    index('records_ws_owner_date_idx').on(t.workspaceId, t.ownerUserId, t.applicableDate),
    index('records_search_idx').using('gin', t.searchTsv),
  ],
);

/** Append-only: the app role has no UPDATE or DELETE grant (rls.sql). */
export const recordRevisions = pgTable(
  'record_revisions',
  {
    id: text('id').primaryKey(),
    recordId: text('record_id')
      .notNull()
      .references(() => records.id),
    workspaceId: text('workspace_id').notNull(),
    revisionNo: integer('revision_no').notNull(),
    kind: revisionKind('kind').notNull(),
    contentHash: text('content_hash').notNull(),
    title: text('title').notNull(),
    summary: text('summary'),
    payload: jsonb('payload').notNull().default({}),
    // metadata as of this revision
    projectId: text('project_id'),
    applicableDate: date('applicable_date').notNull(),
    visibility: visibility('visibility').notNull(),
    noteKind: noteKind('note_kind'),
    changedBy: text('changed_by').references(() => users.id),
    capturedAt: tz('captured_at').notNull().defaultNow(),
  },
  (t) => [unique('record_revisions_record_no_key').on(t.recordId, t.revisionNo)],
);

export const recordAudiences = pgTable(
  'record_audiences',
  {
    recordId: text('record_id')
      .notNull()
      .references(() => records.id),
    userId: text('user_id')
      .notNull()
      .references(() => users.id),
    workspaceId: text('workspace_id').notNull(),
  },
  (t) => [primaryKey({ columns: [t.recordId, t.userId] })],
);

export const recordTags = pgTable(
  'record_tags',
  {
    recordId: text('record_id')
      .notNull()
      .references(() => records.id),
    tag: text('tag').notNull(),
    workspaceId: text('workspace_id').notNull(),
  },
  (t) => [primaryKey({ columns: [t.recordId, t.tag] })],
);

export const recordPeople = pgTable(
  'record_people',
  {
    recordId: text('record_id')
      .notNull()
      .references(() => records.id),
    workspaceId: text('workspace_id').notNull(),
    identityId: text('identity_id').references(() => identities.id),
    personLabel: text('person_label').notNull(),
  },
  (t) => [primaryKey({ columns: [t.recordId, t.personLabel] })],
);
