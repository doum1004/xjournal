import { date, index, jsonb, pgTable, primaryKey, real, text, unique } from 'drizzle-orm/pg-core';
import { linkOrigin } from './enums';
import { projects, tz, workspaces } from './identity';
import { recordRevisions, records } from './records';

// schema.md §6. Work items (spec §3.5) group the records of one piece of work; bundles hold
// the day's records. Both are derived, built by system jobs.

/** One piece of work, anchored on a Jira issue or a pull request. */
export const workItems = pgTable(
  'work_items',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id),
    projectId: text('project_id').references(() => projects.id),
    /** The anchor: a Jira key ('PIX-123') or a pull request ('owner/repo#12'). */
    key: text('key'),
    title: text('title').notNull(),
    /** The anchor in its source: the Jira issue or the pull request. */
    url: text('url'),
    createdAt: tz('created_at').notNull().defaultNow(),
    updatedAt: tz('updated_at').notNull().defaultNow(),
  },
  // Rebuilding keeps an item's ID, since reports cite it.
  (t) => [unique('work_items_project_key_key').on(t.projectId, t.key)],
);

export const workItemLinks = pgTable(
  'work_item_links',
  {
    workItemId: text('work_item_id')
      .notNull()
      .references(() => workItems.id),
    recordId: text('record_id')
      .notNull()
      .references(() => records.id),
    workspaceId: text('workspace_id').notNull(),
    origin: linkOrigin('origin').notNull(),
    /** For 'ai' links. */
    confidence: real('confidence'),
    createdAt: tz('created_at').notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.workItemId, t.recordId] }),
    index('work_item_links_record_idx').on(t.recordId),
  ],
);

/**
 * Records the model has already been asked to place in a work item, at the revision it saw
 * (docs/adr/0009). A record is asked about again only when it changes. System only.
 */
export const workItemAiChecks = pgTable('work_item_ai_checks', {
  recordId: text('record_id')
    .primaryKey()
    .references(() => records.id),
  workspaceId: text('workspace_id').notNull(),
  revisionId: text('revision_id').notNull(),
  checkedAt: tz('checked_at').notNull().defaultNow(),
});

/** One bundle per project and date; rebuilt whenever its inputs change. */
export const dailyBundles = pgTable(
  'daily_bundles',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id').notNull(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id),
    date: date('date').notNull(),
    /** Over the sorted record revision IDs and the coverage. */
    contentHash: text('content_hash').notNull(),
    /** `{connectorAccountId: {source, status, syncedThrough, truncatedBefore}}` */
    coverage: jsonb('coverage').notNull(),
    builtAt: tz('built_at').notNull().defaultNow(),
    /** Set (by a trigger on `records`) when an input changes; cleared on rebuild. */
    dirtySince: tz('dirty_since'),
  },
  (t) => [
    unique('daily_bundles_project_date_key').on(t.projectId, t.date),
    index('daily_bundles_dirty_idx').on(t.projectId, t.dirtySince),
  ],
);

export const bundleItems = pgTable(
  'bundle_items',
  {
    bundleId: text('bundle_id')
      .notNull()
      .references(() => dailyBundles.id, { onDelete: 'cascade' }),
    recordRevisionId: text('record_revision_id')
      .notNull()
      .references(() => recordRevisions.id),
    workspaceId: text('workspace_id').notNull(),
  },
  (t) => [primaryKey({ columns: [t.bundleId, t.recordRevisionId] })],
);
