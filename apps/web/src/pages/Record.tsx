import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import type { RecordView, RevisionView } from '@xjournal/core';
import { useState } from 'react';
import { ApiError, api } from '../api';
import { Badge, Button, ErrorNote, inputClass, Linkified, Panel } from '../components/ui';
import { longDate } from '../dates';
import { useProject } from '../project';

// Record detail (plan.md M1): the current text, where it's filed, and its revision history.

export function RecordPage({ id }: { id: string }) {
  const record = useQuery({ queryKey: ['record', id], queryFn: () => api.record(id) });
  const revisions = useQuery({ queryKey: ['revisions', id], queryFn: () => api.revisions(id) });

  if (record.error) {
    return record.error instanceof ApiError && record.error.status === 404 ? (
      <Panel>Not found, or not visible to you.</Panel>
    ) : (
      <ErrorNote error={record.error} />
    );
  }
  if (!record.data) return <p className="text-sm text-muted">Loading…</p>;

  const r = record.data;
  const revs = revisions.data?.items ?? [];
  const latest = revs.at(-1);
  const text =
    typeof latest?.payload.text === 'string' ? latest.payload.text : (r.summary ?? r.title);

  return (
    <div className="space-y-6">
      <Panel>
        <div className="flex flex-wrap items-baseline gap-2">
          <h1 className="text-lg font-semibold">{r.title}</h1>
          <Badge>{r.kind.replace('_', ' ')}</Badge>
          {r.noteKind && <Badge tone="accent">{r.noteKind}</Badge>}
          {r.projectId == null && <Badge tone="warn">inbox</Badge>}
        </div>
        <p className="mt-1 text-sm text-muted">
          <Link
            to="/day/$date"
            params={{ date: r.applicableDate }}
            className="hover:text-accent hover:underline"
          >
            {longDate(r.applicableDate)}
          </Link>{' '}
          · {r.source} · {r.visibility} · by {r.owner.name}
          {r.url && (
            <>
              {' · '}
              <a
                href={r.url}
                target="_blank"
                rel="noreferrer noopener"
                className="text-accent underline"
              >
                open in source
              </a>
            </>
          )}
        </p>
        {r.tags.length > 0 && (
          <p className="mt-1 text-sm text-muted">{r.tags.map((t) => `!${t}`).join(' ')}</p>
        )}
        <div className="mt-4 whitespace-pre-wrap break-words text-sm leading-6">
          <Linkified text={text} />
        </div>
      </Panel>

      {r.kind === 'note' && r.isMine && <EditNote record={r} text={text} />}
      {r.isMine && <RouteForm record={r} />}
      <Revisions revisions={revs} />
    </div>
  );
}

function EditNote({ record, text }: { record: RecordView; text: string }) {
  const [draft, setDraft] = useState<string | null>(null);
  const qc = useQueryClient();
  const save = useMutation({
    mutationFn: (t: string) => api.editNote(record.id, t),
    onSuccess: () => {
      setDraft(null);
      qc.invalidateQueries();
    },
  });
  if (draft === null) {
    return <Button onClick={() => setDraft(text)}>Edit note</Button>;
  }
  return (
    <Panel>
      <h2 className="mb-2 font-semibold">Edit note</h2>
      <p className="mb-2 text-xs text-muted">
        Saving adds a new revision; the original text is kept.
      </p>
      <textarea
        aria-label="Note text"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        rows={6}
        className={`w-full ${inputClass}`}
      />
      {save.error && <ErrorNote error={save.error} />}
      <div className="mt-2 flex gap-2">
        <Button
          variant="primary"
          disabled={!draft.trim() || save.isPending}
          onClick={() => save.mutate(draft)}
        >
          Save
        </Button>
        <Button variant="ghost" onClick={() => setDraft(null)}>
          Cancel
        </Button>
      </div>
    </Panel>
  );
}

export function RouteForm({ record, compact = false }: { record: RecordView; compact?: boolean }) {
  const { projects } = useProject();
  const qc = useQueryClient();
  const [projectId, setProjectId] = useState(record.projectId ?? projects[0]?.id ?? '');
  const [date, setDate] = useState(record.applicableDate);
  const route = useMutation({
    mutationFn: () =>
      api.route(record.id, {
        projectId: projectId || null,
        ...(date !== record.applicableDate ? { date } : {}),
      }),
    onSuccess: () => qc.invalidateQueries(),
  });

  const form = (
    <form
      className="flex flex-wrap items-center gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        route.mutate();
      }}
    >
      <select
        aria-label="Project"
        value={projectId}
        onChange={(e) => setProjectId(e.target.value)}
        className={inputClass}
      >
        {projects.map((p) => (
          <option key={p.id} value={p.id}>
            #{p.slug}
          </option>
        ))}
        <option value="">Inbox</option>
      </select>
      <input
        type="date"
        aria-label="Date"
        value={date}
        onChange={(e) => setDate(e.target.value)}
        className={inputClass}
      />
      <Button type="submit" variant={compact ? 'default' : 'primary'} disabled={route.isPending}>
        {compact ? 'File' : 'Save'}
      </Button>
      {route.error && <span className="text-sm text-warn">{(route.error as Error).message}</span>}
    </form>
  );
  if (compact) return <div className="mt-2">{form}</div>;
  return (
    <Panel>
      <h2 className="mb-2 font-semibold">Project and date</h2>
      <p className="mb-2 text-xs text-muted">
        Changes add a metadata revision; the text is untouched.
      </p>
      {form}
    </Panel>
  );
}

function Revisions({ revisions }: { revisions: RevisionView[] }) {
  const { projects } = useProject();
  const slug = (id: string | null) =>
    id ? `#${projects.find((p) => p.id === id)?.slug ?? '?'}` : 'inbox';
  return (
    <Panel>
      <h2 className="mb-2 font-semibold">Revisions</h2>
      <ol className="space-y-1 text-sm">
        {revisions.map((v) => (
          <li key={v.id} className="flex flex-wrap gap-x-3 text-muted">
            <span className="font-mono tabular-nums text-ink">r{v.revisionNo}</span>
            <span>{v.kind}</span>
            <span>{new Date(v.capturedAt).toLocaleString()}</span>
            <span>
              {slug(v.projectId)} · {v.applicableDate}
            </span>
            <span className="font-mono text-xs" title="Content hash">
              {v.contentHash.slice(0, 10)}
            </span>
          </li>
        ))}
      </ol>
    </Panel>
  );
}
