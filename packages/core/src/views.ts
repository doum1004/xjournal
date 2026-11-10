import type {
  InputTier,
  MemberRole,
  NoteKind,
  RecordKind,
  ReportKind,
  RoutingStatus,
  Visibility,
} from './enums';

/** A record as the API returns it (api.md §2). */
export interface RecordView {
  id: string;
  revisionId: string;
  revisionNo: number;
  source: string;
  externalId: string;
  kind: RecordKind;
  tier: InputTier;
  title: string;
  summary?: string;
  url?: string;
  eventTime: string;
  applicableDate: string;
  enteredAt?: string;
  projectId: string | null;
  routingStatus: RoutingStatus;
  noteKind?: NoteKind;
  tags: string[];
  owner: { id: string; name: string };
  isMine: boolean;
  visibility: Visibility;
  hidden: boolean;
  workItemIds: string[];
}

export interface RevisionView {
  id: string;
  revisionNo: number;
  kind: string;
  contentHash: string;
  title: string;
  summary?: string;
  payload: Record<string, unknown>;
  projectId: string | null;
  applicableDate: string;
  visibility: Visibility;
  noteKind?: NoteKind;
  changedBy: string | null;
  capturedAt: string;
}

export interface ProjectView {
  id: string;
  slug: string;
  name: string;
  timeZone: string;
  role: string;
  defaultNoteVisibility: Visibility;
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

/** How completely one connector covered one day (spec §5.9). */
export interface ConnectorCoverage {
  source: string;
  /**
   * complete: every stream synced past the end of the day; pending: not yet; error: the last
   * attempt failed before that; truncated: the source keeps no history this far back.
   */
  status: 'complete' | 'pending' | 'error' | 'truncated';
  /** For 'truncated': the source has nothing before this instant. */
  truncatedBefore?: string;
}
/** Per connector account, keyed by its ID. */
export type Coverage = Record<string, ConnectorCoverage>;

export interface BundleView {
  id: string;
  hash: string;
  builtAt: string;
  /** An input changed since it was built; a rebuild is due. */
  dirty: boolean;
  /** Items the caller can see. */
  itemCount: number;
}

/** One entry of `GET /projects/{p}/days`. Daily reports arrive in M3. */
export interface DaySummary {
  date: string;
  recordCount: number;
  mineCount: number;
  bundleHash: string | null;
  /** No bundle yet, or one whose inputs changed. */
  dirty: boolean;
  /** Your daily report for the day, if any. */
  daily: { reportId: string; status: string; versionId: string | null } | null;
  coverage: Coverage;
}

/** A work item (spec §3.5) and its records in view: the day's, or the report's inputs'. */
export interface WorkItemGroup {
  id: string;
  /** The anchor: a Jira key ('PIX-123') or a pull request ('owner/repo#12'). */
  key: string | null;
  title: string;
  url: string | null;
  records: RecordView[];
}

/** A work item active in a report's period, for weekly and longer reports. */
export interface WorkItemSummary {
  id: string;
  key: string | null;
  title: string;
  url: string | null;
  /** Dates in the period with a record of the item. */
  days: string[];
  /** Kinds of record, with counts, e.g. {pull_request: 2, message: 1}. */
  kinds: Record<string, number>;
}

/** `GET /projects/{p}/days/{date}`: the day's records, grouped by work item. */
export interface DayView {
  date: string;
  projectId: string;
  bundle: BundleView | null;
  /** A record in several items appears in each. */
  workItems: WorkItemGroup[];
  /** Records in no work item. */
  unlinked: RecordView[];
  daily: { reportId: string; status: string; versionId: string | null } | null;
  coverage: Coverage;
}

// ------------------------------------------------------------------------------------------
// Settings (api.md §3.2a)
// ------------------------------------------------------------------------------------------

export interface WorkspaceView {
  id: string;
  name: string;
  domain: string;
  timeZone: string;
  /** 1 = Monday … 7 = Sunday (ISO). */
  weekStart: number;
  /** Any date in the first week of a bi-weekly pair (spec §5.7). */
  biweeklyAnchor: string;
  isOwner: boolean;
}

export interface StreamStateView {
  stream: string;
  lastSuccessAt: string | null;
  lastAttemptAt: string | null;
  lastError: string | null;
  historyFloor: string | null;
}

export interface ConnectorView {
  id: string;
  kind: string;
  source: string;
  displayName: string;
  authType: string;
  hasSecret: boolean;
  status: string;
  config: Record<string, unknown>;
  projectIds: string[];
  streams: StreamStateView[];
  createdAt: string;
  disconnectedAt: string | null;
}

export interface ConnectorKindView {
  kind: string;
  displayName: string;
  authTypes: string[];
  streams: { key: string; description: string }[];
  policy: { fullText: boolean; historyLimitDays?: number };
  configSchema: Record<string, unknown> | null;
}

export interface IdentityView {
  id: string;
  source: string;
  accountKey: string;
  aliases: string[];
}

// ------------------------------------------------------------------------------------------
// Reports (api.md §3.5, §4)
// ------------------------------------------------------------------------------------------

export type ReportAudienceInput = 'me' | 'project';

export interface ReportRef {
  /** `{reportId, kind, period, status, currentVersionId}` from resolve. */
  reportId: string;
  kind: ReportKind;
  projectId: string | null;
  period: { start: string; endExcl: string; title: string };
  audienceKey: string;
  status: 'current' | 'stale' | 'superseded' | 'rejected';
  currentVersionId: string | null;
}

export interface CitationView {
  anchor: string;
  type: 'record_revision' | 'work_item' | 'report_version' | 'stat';
  id: string;
  /** Resolved for display: a record's title and link, an input report's title, a stat value. */
  title: string | null;
  url: string | null;
}

export interface ReportVersionView extends ReportRef {
  versionId: string;
  versionNo: number;
  bodyMd: string;
  path: 'agent' | 'direct' | 'import';
  client: string | null;
  model: string | null;
  templateVersion: string;
  changeReason: 'factual' | 'editorial' | 'initial';
  changeSummary: string | null;
  createdAt: string;
  citations: CitationView[];
}

export interface StatView {
  metric: string;
  value: number;
  description: string;
}

export interface ReportInputs {
  report: ReportRef & { audience: { id: string; name: string }[] };
  template: { version: string; sections: string[]; instructions: string };
  guidance: { id: string; versionId: string; scope: string; text: string }[];
  bundles?: {
    date: string;
    hash: string;
    coverage: Coverage;
    workItems: WorkItemGroup[];
    unlinked: RecordView[];
  }[];
  /** Weekly and longer: the work items with records in the period. Cite them as [[w:<id>]]. */
  workItems?: WorkItemSummary[];
  inputReports?: {
    versionId: string;
    kind: ReportKind;
    period: { start: string; endExcl: string };
    bodyMd: string;
    status: string;
    statements: { anchor: string; text: string }[];
  }[];
  context?: RecordView[];
  previous?: { versionId: string; bodyMd: string };
  /** The same kind's previous period, for a bi-weekly's plan vs. actual (spec §5.3). */
  previousPeriod?: {
    versionId: string;
    period: { start: string; endExcl: string; title: string };
    bodyMd: string;
    statements: { anchor: string; text: string }[];
  };
  stats: StatView[];
  gaps: {
    missingDays: string[];
    /** Input reports (weekly or monthly) the period should have but doesn't, up to today. */
    missingInputs?: { kind: ReportKind; start: string; title: string }[];
    staleInputs: string[];
    coverage: Coverage;
  };
  refFormat: string;
  inputHash: string;
}

export interface DueReport {
  kind: ReportKind;
  date: string;
  projectId: string;
  reason: 'missing' | 'stale';
}

export interface StatusView {
  projects: { id: string; slug: string; name: string; role: MemberRole }[];
  /** What a morning run should write, oldest first (spec §5.1). */
  due: DueReport[];
  missingDays: { projectId: string; date: string }[];
  staleReports: { reportId: string; kind: ReportKind; date: string; projectId: string | null }[];
  inboxCount: number;
  connectors: {
    id: string;
    source: string;
    status: string;
    lastSuccessAt: string | null;
    error: string | null;
  }[];
}

/** A career log entry (spec §9.8): one quarter's public-safe bullets, private to its owner. */
export interface CareerEntryView {
  id: string;
  projectId: string;
  periodStart: string;
  title: string;
  bodyMd: string;
  status: 'draft' | 'approved';
  sourceVersionId: string | null;
  approvedAt: string | null;
  updatedAt: string;
  /** Things that may not be public-safe, found by a deterministic check. */
  warnings: { line: number; text: string; reason: string }[];
}
