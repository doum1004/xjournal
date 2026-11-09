import { useMutation, useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import type { ReportVersionView } from '@xjournal/core';
import { useState } from 'react';
import { api } from '../api';
import { Markdown } from './Markdown';
import { Badge, Button, ErrorNote } from './ui';

// One report version: its body with citations as links, provenance, status, versions and
// publishing (daily reports to the Confluence work log).

const when = (iso: string) =>
  new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

export function ReportBody({ v, compact = false }: { v: ReportVersionView; compact?: boolean }) {
  const [force, setForce] = useState(false);
  const publish = useMutation({ mutationFn: () => api.publish(v.versionId, force) });
  const versions = useQuery({
    queryKey: ['report-versions', v.reportId],
    queryFn: () => api.reportVersions(v.reportId),
    enabled: !compact,
  });
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
        <Badge tone={v.status === 'stale' ? 'warn' : 'accent'}>
          {v.status === 'stale' ? 'out of date' : v.status}
        </Badge>
        <span>
          v{v.versionNo} ·{' '}
          {v.path === 'import'
            ? 'imported from the prototype'
            : `${v.client ?? v.path}${v.model ? ` · ${v.model}` : ''}`}{' '}
          · {when(v.createdAt)}
        </span>
        {v.changeSummary && v.versionNo > 1 && <span>· {v.changeSummary}</span>}
        {compact && (
          <Link
            to="/reports/$versionId"
            params={{ versionId: v.versionId }}
            className="text-accent hover:underline"
          >
            Details
          </Link>
        )}
      </div>
      <Markdown body={v.bodyMd} citations={v.citations} />
      {!compact && v.kind === 'daily' && (
        <div className="flex flex-wrap items-center gap-2 border-t border-line pt-3">
          <Button onClick={() => publish.mutate()} disabled={publish.isPending}>
            {publish.isPending ? 'Publishing…' : 'Publish to the Confluence work log'}
          </Button>
          <label className="flex items-center gap-1 text-xs text-muted">
            <input type="checkbox" checked={force} onChange={(e) => setForce(e.target.checked)} />
            overwrite edits made in Confluence
          </label>
          {publish.error && <ErrorNote error={publish.error} />}
          {publish.data?.status === 'published' && (
            <a
              href={publish.data.url}
              target="_blank"
              rel="noreferrer noopener"
              className="text-sm text-accent underline"
            >
              Published to {publish.data.pageTitle}
            </a>
          )}
          {publish.data?.status === 'refused' && (
            <div className="w-full rounded-md border border-warn/40 p-3 text-sm">
              <p className="text-warn">
                The row was edited in Confluence since the hub last wrote it:
              </p>
              <pre className="mt-2 whitespace-pre-wrap text-xs">{publish.data.currentText}</pre>
              <p className="mt-2 text-muted">
                Put that text into the report, or tick “overwrite” and publish again.
              </p>
            </div>
          )}
        </div>
      )}
      {!compact && versions.data && versions.data.items.length > 1 && (
        <div className="border-t border-line pt-3">
          <h3 className="mb-1 text-sm font-semibold">Versions</h3>
          <ul className="space-y-1 text-sm">
            {versions.data.items.map((x) => (
              <li key={x.versionId}>
                <Link
                  to="/reports/$versionId"
                  params={{ versionId: x.versionId }}
                  className={
                    x.versionId === v.versionId ? 'font-semibold' : 'text-accent hover:underline'
                  }
                >
                  v{x.versionNo}
                </Link>{' '}
                <span className="text-muted">
                  {x.changeReason} · {when(x.createdAt)}
                  {x.changeSummary ? ` · ${x.changeSummary}` : ''}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
