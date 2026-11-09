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
