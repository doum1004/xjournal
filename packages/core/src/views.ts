import type { InputTier, NoteKind, RecordKind, RoutingStatus, Visibility } from './enums';

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
  daily: null;
  coverage: Coverage;
}

/** `GET /projects/{p}/days/{date}`. Work items arrive in Phase 2, so every record is unlinked. */
export interface DayView {
  date: string;
  projectId: string;
  bundle: BundleView | null;
  workItems: { id: string; title: string; records: RecordView[] }[];
  unlinked: RecordView[];
  daily: null;
  coverage: Coverage;
}
