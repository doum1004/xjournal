import { date, index, jsonb, pgTable, primaryKey, text, unique } from 'drizzle-orm/pg-core';
import { projects, tz } from './identity';
import { recordRevisions } from './records';

// schema.md §6. Work items arrive in Phase 2; until then a bundle groups by source only.

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
