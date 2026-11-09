import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import type { ReportVersionView } from '@xjournal/core';
import { useState } from 'react';
import { alreadyRunning, api } from '../api';
import { Diff } from './Diff';
import { Markdown } from './Markdown';
import { Badge, Button, ErrorNote, inputClass } from './ui';

// One report version: its body with citations as links, provenance and status, and (full
// view) regenerate, download as Markdown, compare with the previous version, versions, and
// publishing (daily reports to the Confluence work log).

const when = (iso: string) =>
  new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

export async function downloadMarkdown(versionId: string) {
  const { name, text } = await api.exportMarkdown(versionId);
  const url = URL.createObjectURL(new Blob([text], { type: 'text/markdown' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

/** Generate (or regenerate) a report with the hub's own model call; polls until it's done. */
export function useGenerate(reportId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (arg: { instructions?: string; reportId?: string } = {}) => {
      const id = arg.reportId ?? reportId;
      if (!id) throw new Error('No report to write');
      return api.generate(id, arg.instructions);
    },
    onSuccess: (r) => {
      const refresh = () =>
        Promise.all(
          ['report-version', 'report-versions', 'day', 'days', 'reports', 'status'].map((k) =>
            qc.invalidateQueries({ queryKey: [k] }),
          ),
        );
      refresh();
      // Queued: the worker writes it in the background; check back a few times.
      if (r && 'queued' in r) for (const ms of [5000, 15000, 30000, 60000]) setTimeout(refresh, ms);
    },
  });
}

export function ReportBody({ v, compact = false }: { v: ReportVersionView; compact?: boolean }) {
  const [force, setForce] = useState(false);
  const [instructions, setInstructions] = useState('');
  const [showRegen, setShowRegen] = useState(false);
  const [compare, setCompare] = useState(false);
  const publish = useMutation({ mutationFn: () => api.publish(v.versionId, force) });
  const generate = useGenerate(v.reportId);
  const download = useMutation({ mutationFn: () => downloadMarkdown(v.versionId) });
  const versions = useQuery({
    queryKey: ['report-versions', v.reportId],
    queryFn: () => api.reportVersions(v.reportId),
    enabled: !compact,
  });
  const prevId = versions.data?.items.find((x) => x.versionNo < v.versionNo)?.versionId;
  const prev = useQuery({
    queryKey: ['report-version', prevId],
    queryFn: () => api.reportVersion(prevId as string),
    enabled: compare && !!prevId,
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
            : v.path === 'direct'
              ? `written by the hub${v.model ? ` (${v.model})` : ''}`
              : `${v.client ?? 'agent'}${v.model ? ` · ${v.model}` : ''}`}{' '}
          · {when(v.createdAt)}
        </span>
        {v.versionNo > 1 && <Badge>{v.changeReason}</Badge>}
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
      {v.status === 'stale' && (
        <p className="text-sm text-warn">
          The evidence or guidance changed since this version was written.
        </p>
      )}
      <Markdown body={v.bodyMd} citations={v.citations} />

      {!compact && (
        <div className="flex flex-wrap items-center gap-2 border-t border-line pt-3">
          <Button
            variant={v.status === 'stale' ? 'primary' : 'default'}
            onClick={() => setShowRegen(!showRegen)}
          >
            Regenerate…
          </Button>
          <Button onClick={() => download.mutate()} disabled={download.isPending}>
            Download Markdown
          </Button>
          {prevId && (
            <Button onClick={() => setCompare(!compare)}>
              {compare ? 'Hide changes' : `Compare with v${v.versionNo - 1}`}
            </Button>
          )}
          {v.kind === 'daily' && (
            <>
              <Button onClick={() => publish.mutate()} disabled={publish.isPending}>
                {publish.isPending ? 'Publishing…' : 'Publish to the Confluence work log'}
              </Button>
              <label className="flex items-center gap-1 text-xs text-muted">
                <input
                  type="checkbox"
                  checked={force}
                  onChange={(e) => setForce(e.target.checked)}
                />
                overwrite edits made in Confluence
              </label>
            </>
          )}
        </div>
      )}
      {showRegen && (
        <form
          className="space-y-2 rounded-md border border-line p-3"
          onSubmit={(e) => {
            e.preventDefault();
            generate.mutate(instructions.trim() ? { instructions: instructions.trim() } : {});
          }}
        >
          <textarea
            value={instructions}
            onChange={(e) => setInstructions(e.target.value)}
            rows={2}
            placeholder="Optional, for this version only: e.g. “shorter, and lead with the release”"
            className={`w-full ${inputClass}`}
          />
          <p className="text-xs text-muted">
            For lasting changes add guidance instead (Reports → Guidance): it applies to every
            future report.
          </p>
          <Button type="submit" variant="primary" disabled={generate.isPending}>
            {generate.isPending ? 'Writing…' : 'Write a new version'}
          </Button>
          {alreadyRunning(generate.data) && (
            <p className="text-sm text-muted">It’s already being written.</p>
          )}
          {generate.data && 'queued' in generate.data && generate.data.queued === true && (
            <p className="text-sm text-muted">
              Writing in the background; this page updates when it’s done.
            </p>
          )}
        </form>
      )}
      {[publish.error, generate.error, download.error].map((e, i) =>
        // biome-ignore lint/suspicious/noArrayIndexKey: three fixed slots
        e ? <ErrorNote key={i} error={e} /> : null,
      )}
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
        <div className="rounded-md border border-warn/40 p-3 text-sm">
          <p className="text-warn">The row was edited in Confluence since the hub last wrote it:</p>
          <pre className="mt-2 whitespace-pre-wrap text-xs">{publish.data.currentText}</pre>
          <p className="mt-2 text-muted">
            Put that text into the report, or tick “overwrite” and publish again.
          </p>
        </div>
      )}
      {compare && prev.data && (
        <div>
          <h3 className="mb-1 text-sm font-semibold">
            Changes from v{prev.data.versionNo}{' '}
            <span className="font-normal text-muted">({v.changeReason})</span>
          </h3>
          <Diff before={prev.data.bodyMd} after={v.bodyMd} />
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
                <Badge>{x.changeReason}</Badge>{' '}
                <span className="text-muted">
                  {x.path} · {when(x.createdAt)}
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
