/**
 * Enum values from schema.md §2. The database enums (packages/db) and the Zod schemas
 * are both built from these arrays, so they can't drift apart.
 */
export const trustDomains = ['work', 'personal'] as const;
export const memberRoles = ['viewer', 'commenter', 'contributor', 'manager', 'owner'] as const;
export const visibilities = ['project', 'private', 'restricted'] as const;
export const inviteKinds = ['join', 'recovery'] as const;
export const deviceStatuses = ['pending', 'approved', 'rejected', 'revoked'] as const;
export const inputTiers = [
  'builtin',
  'webhook',
  'email',
  'file_import',
  'agent',
  'manual',
] as const;
export const recordKinds = [
  'pull_request',
  'review',
  'commit',
  'code_comment',
  'issue_created',
  'issue_change',
  'issue_comment',
  'page_edit',
  'page_comment',
  'message',
  'meeting',
  'meeting_summary',
  'email',
  'webhook_event',
  'imported_log',
  'note',
] as const;
export const noteKinds = ['event', 'context', 'guidance', 'reminder'] as const;
export const routingStatuses = ['auto', 'confirmed', 'needs_review'] as const;
export const routedBys = ['hint', 'rule', 'agent', 'model', 'user', 'connector'] as const;
export const revisionKinds = [
  'created',
  'content',
  'metadata',
  'deleted_at_source',
  'redacted',
] as const;
export const reportKinds = [
  'daily',
  'weekly',
  'biweekly',
  'monthly',
  'quarterly',
  'yearly',
] as const;
export const genPaths = ['agent', 'direct', 'import'] as const;
export const changeReasons = ['factual', 'editorial', 'initial'] as const;
export const reportStatuses = ['current', 'stale', 'superseded', 'rejected'] as const;
export const refTypes = ['record_revision', 'work_item', 'report_version', 'stat'] as const;
export const guidanceScopes = ['workspace', 'project', 'report_kind', 'report'] as const;
export const linkOrigins = ['rule', 'ai', 'user'] as const;
export const reminderStates = [
  'suggested',
  'active',
  'snoozed',
  'completed',
  'dismissed',
  'cancelled',
] as const;
export const syncStatuses = ['ok', 'running', 'error', 'disabled'] as const;

export type TrustDomain = (typeof trustDomains)[number];
export type MemberRole = (typeof memberRoles)[number];
export type Visibility = (typeof visibilities)[number];
export type DeviceStatus = (typeof deviceStatuses)[number];
export type InputTier = (typeof inputTiers)[number];
export type RecordKind = (typeof recordKinds)[number];
export type NoteKind = (typeof noteKinds)[number];
export type RoutingStatus = (typeof routingStatuses)[number];
export type RoutedBy = (typeof routedBys)[number];
export type RevisionKind = (typeof revisionKinds)[number];
export type ReportKind = (typeof reportKinds)[number];

/** Role order for "at least" checks; mirrors the Postgres enum order used by RLS. */
export function roleAtLeast(role: MemberRole | null | undefined, min: MemberRole): boolean {
  return role != null && memberRoles.indexOf(role) >= memberRoles.indexOf(min);
}
