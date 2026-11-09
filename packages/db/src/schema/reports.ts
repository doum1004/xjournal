import { sql } from 'drizzle-orm';
import {
  check,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  unique,
} from 'drizzle-orm/pg-core';
import {
  changeReason,
  genPath,
  guidanceScope,
  refType,
  reportKind,
  reportStatus,
  visibility,
} from './enums';
import { projects, tz, users, workspaces } from './identity';

// schema.md §7: reports and guidance (Layers 3–4).

/** One logical report: project × kind × period × audience. */
export const reports = pgTable(
  'reports',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id),
    /** null: a workspace aggregate (spec Flow E). */
    projectId: text('project_id').references(() => projects.id),
    kind: reportKind('kind').notNull(),
    periodStart: date('period_start').notNull(),
    periodEndExcl: date('period_end_excl').notNull(),
    /** 'project', or 'me:<userId>' for a personal report. */
    audienceKey: text('audience_key').notNull(),
    currentVersionId: text('current_version_id'),
    status: reportStatus('status').notNull().default('current'),
    staleSince: tz('stale_since'),
    createdAt: tz('created_at').notNull().defaultNow(),
  },
  (t) => [
    unique('reports_scope_key').on(
      t.workspaceId,
      t.projectId,
      t.kind,
      t.periodStart,
      t.audienceKey,
    ),
    index('reports_project_kind_period_idx').on(t.projectId, t.kind, t.periodStart),
  ],
);

export const reportAudience = pgTable(
  'report_audience',
  {
    reportId: text('report_id')
      .notNull()
      .references(() => reports.id),
    userId: text('user_id')
      .notNull()
      .references(() => users.id),
    workspaceId: text('workspace_id').notNull(),
  },
  (t) => [primaryKey({ columns: [t.reportId, t.userId] })],
);

/** Append-only. */
export const reportVersions = pgTable(
  'report_versions',
  {
    id: text('id').primaryKey(),
    reportId: text('report_id')
      .notNull()
      .references(() => reports.id),
    workspaceId: text('workspace_id').notNull(),
    versionNo: integer('version_no').notNull(),
    bodyMd: text('body_md').notNull(),
    path: genPath('path').notNull(),
    model: text('model'),
    templateVersion: text('template_version').notNull(),
    client: text('client'),
    actorUserId: text('actor_user_id').references(() => users.id),
    inputHash: text('input_hash').notNull(),
    guidanceHash: text('guidance_hash').notNull(),
    changeReason: changeReason('change_reason').notNull(),
    changeSummary: text('change_summary'),
    validation: jsonb('validation').notNull(),
    createdAt: tz('created_at').notNull().defaultNow(),
  },
  (t) => [unique('report_versions_report_no_key').on(t.reportId, t.versionNo)],
);

/** Exactly which inputs a version used. */
export const reportInputs = pgTable(
  'report_inputs',
  {
    reportVersionId: text('report_version_id')
      .notNull()
      .references(() => reportVersions.id),
    workspaceId: text('workspace_id').notNull(),
    inputType: text('input_type').notNull(),
    inputId: text('input_id').notNull(),
    inputHash: text('input_hash').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.reportVersionId, t.inputType, t.inputId] }),
    check(
      'report_inputs_type_check',
      sql`${t.inputType} in ('bundle', 'report_version', 'guidance_version')`,
    ),
    index('report_inputs_input_idx').on(t.inputType, t.inputId),
  ],
);

/** Per-statement evidence (spec §5.8); `anchor` is the statement's stable ID in body_md. */
export const evidenceRefs = pgTable(
  'evidence_refs',
  {
    reportVersionId: text('report_version_id')
      .notNull()
      .references(() => reportVersions.id),
    workspaceId: text('workspace_id').notNull(),
    anchor: text('anchor').notNull(),
    refType: refType('ref_type').notNull(),
    refId: text('ref_id').notNull(),
  },
  (t) => [primaryKey({ columns: [t.reportVersionId, t.anchor, t.refType, t.refId] })],
);

/** Deterministic numbers in a report (spec §5.8): the query and its result. */
export const reportStats = pgTable('report_stats', {
  id: text('id').primaryKey(),
  reportVersionId: text('report_version_id')
    .notNull()
    .references(() => reportVersions.id),
  workspaceId: text('workspace_id').notNull(),
  metric: text('metric').notNull(),
  query: jsonb('query').notNull(),
  value: jsonb('value').notNull(),
});

export const guidance = pgTable('guidance', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id')
    .notNull()
    .references(() => workspaces.id),
  scope: guidanceScope('scope').notNull(),
  projectId: text('project_id').references(() => projects.id),
  reportKind: reportKind('report_kind'),
  reportId: text('report_id').references(() => reports.id),
  authorUserId: text('author_user_id')
    .notNull()
    .references(() => users.id),
  visibility: visibility('visibility').notNull().default('project'),
  currentVersionId: text('current_version_id'),
  archivedAt: tz('archived_at'),
});

/** Append-only. */
export const guidanceVersions = pgTable(
  'guidance_versions',
  {
    id: text('id').primaryKey(),
    guidanceId: text('guidance_id')
      .notNull()
      .references(() => guidance.id),
    workspaceId: text('workspace_id').notNull(),
    versionNo: integer('version_no').notNull(),
    text: text('text').notNull(),
    contentHash: text('content_hash').notNull(),
    createdBy: text('created_by')
      .notNull()
      .references(() => users.id),
    createdAt: tz('created_at').notNull().defaultNow(),
  },
  (t) => [unique('guidance_versions_guidance_no_key').on(t.guidanceId, t.versionNo)],
);

/** Published copies of report versions (schema.md §8), e.g. a Confluence work-log row. */
export const exportsTable = pgTable(
  'exports',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id').notNull(),
    reportVersionId: text('report_version_id').references(() => reportVersions.id),
    /** 'confluence-worklog', 'markdown', … */
    destination: text('destination').notNull(),
    /** Where inside the destination, e.g. the date of a work-log row. */
    target: text('target').notNull(),
    externalUrl: text('external_url'),
    /** Hash of the published text as the destination stores it: the edit-conflict guard. */
    contentHash: text('content_hash'),
    createdBy: text('created_by')
      .notNull()
      .references(() => users.id),
    createdAt: tz('created_at').notNull().defaultNow(),
  },
  (t) => [index('exports_destination_target_idx').on(t.createdBy, t.destination, t.target)],
);
