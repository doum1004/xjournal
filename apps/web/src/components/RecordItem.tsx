import { Link } from '@tanstack/react-router';
import type { RecordView } from '@xjournal/core';
import type { ReactNode } from 'react';
import { shortDate } from '../dates';
import { Badge } from './ui';

const KIND_LABEL: Record<string, string> = { imported_log: 'log', note: 'note' };

export function RecordItem({
  record,
  showDate = false,
  projectSlug,
  children,
}: {
  record: RecordView;
  showDate?: boolean;
  projectSlug?: string | undefined;
  children?: ReactNode;
}) {
  return (
    <li className="border-b border-line py-3 last:border-0">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        {showDate && (
          <span className="font-mono text-xs tabular-nums text-muted">
            {shortDate(record.applicableDate)}
          </span>
        )}
        <Link
          to="/records/$id"
          params={{ id: record.id }}
          className="font-medium hover:text-accent hover:underline"
        >
          {record.title}
        </Link>
        <Badge>{KIND_LABEL[record.kind] ?? record.kind.replace('_', ' ')}</Badge>
        {record.noteKind && record.noteKind !== 'event' && (
          <Badge tone="accent">{record.noteKind}</Badge>
        )}
        {record.projectId == null && <Badge tone="warn">inbox</Badge>}
        {projectSlug && <span className="text-xs text-muted">#{projectSlug}</span>}
        {record.tags.map((t) => (
          <span key={t} className="text-xs text-muted">
            !{t}
          </span>
        ))}
        {record.revisionNo > 1 && <span className="text-xs text-muted">r{record.revisionNo}</span>}
      </div>
      {record.summary && record.summary !== record.title && (
        <p className="mt-1 line-clamp-3 whitespace-pre-line text-sm text-muted">{record.summary}</p>
      )}
      {children}
    </li>
  );
}
