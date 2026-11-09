import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import type { CareerEntryView } from '@xjournal/core';
import { useState } from 'react';
import { api } from '../api';
import { Badge, Button, Empty, ErrorNote, inputClass, Panel } from '../components/ui';
import { useProject } from '../project';

// The career log (spec §9.8): each quarterly report proposes public-safe accomplishment
// bullets; here the user edits and approves them, and exports the approved ones by hand.
// Entries are private to their owner and never synced anywhere.

function download(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/markdown' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

export function CareerPage() {
  const career = useQuery({ queryKey: ['career'], queryFn: api.career });
  const exp = useMutation({
    mutationFn: (drafts: boolean) => api.exportCareer(drafts),
    onSuccess: ({ name, text }) => download(name, text),
  });
  const entries = [...(career.data?.items ?? [])].reverse(); // newest quarter first

  return (
    <div className="space-y-4">
      <Panel>
        <div className="flex flex-wrap items-start gap-3">
          <div className="min-w-0 flex-1">
            <h1 className="text-lg font-semibold">Career log</h1>
            <p className="text-sm text-muted">
              Public-safe accomplishments, one entry per quarter. Each quarterly report proposes a
              draft; edit it, approve it, and export the approved quarters for a profile or a CV.
              Nothing here leaves the hub unless you export it.
            </p>
          </div>
          <div className="flex gap-2">
            <Button onClick={() => exp.mutate(false)} disabled={exp.isPending}>
              Export approved
            </Button>
            <Button variant="ghost" onClick={() => exp.mutate(true)} disabled={exp.isPending}>
              With drafts
            </Button>
          </div>
        </div>
        {exp.error && <ErrorNote error={exp.error} />}
      </Panel>

      <AddEntry />

      {career.error && <ErrorNote error={career.error} />}
      {!career.isPending && entries.length === 0 ? (
        <Panel>
          <Empty>
            No entries yet. Write a quarterly report, or run{' '}
            <code className="font-mono">hub import career</code> to bring in the prototype's log.
          </Empty>
        </Panel>
      ) : (
        entries.map((e) => <EntryCard key={`${e.id}:${e.updatedAt}`} entry={e} />)
      )}
    </div>
  );
}

function AddEntry() {
  const { project } = useProject();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [body, setBody] = useState('');
  const add = useMutation({
    mutationFn: () => api.addCareer({ projectId: project?.id ?? '', date, bodyMd: body.trim() }),
    onSuccess: () => {
      setBody('');
      setOpen(false);
      qc.invalidateQueries({ queryKey: ['career'] });
    },
  });
  if (!open)
    return (
      <Button onClick={() => setOpen(true)} disabled={!project}>
        + Write a quarter by hand
      </Button>
    );
  return (
    <Panel>
      <form
        className="space-y-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (body.trim()) add.mutate();
        }}
      >
        <label className="flex items-center gap-2 text-sm">
          Any date in the quarter
          <input
            type="date"
            required
            value={date}
            onChange={(e) => setDate(e.target.value)}
            className={inputClass}
          />
          <span className="text-muted">#{project?.slug}</span>
        </label>
        <textarea
          aria-label="Accomplishments"
          rows={5}
          required
          placeholder={'- Led …\n- Built …\n- Skills: …'}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          className={`w-full font-mono ${inputClass}`}
        />
        {add.error && <ErrorNote error={add.error} />}
        <div className="flex gap-2">
          <Button type="submit" variant="primary" disabled={add.isPending}>
            Add draft
          </Button>
          <Button variant="ghost" onClick={() => setOpen(false)}>
            Cancel
          </Button>
        </div>
      </form>
    </Panel>
  );
}

function EntryCard({ entry }: { entry: CareerEntryView }) {
  const { projects } = useProject();
  const qc = useQueryClient();
  const [body, setBody] = useState(entry.bodyMd);
  const dirty = body.trim() !== entry.bodyMd;
  const done = () => qc.invalidateQueries({ queryKey: ['career'] });
  const save = useMutation({
    mutationFn: (status?: 'draft' | 'approved') =>
      api.updateCareer(entry.id, { bodyMd: body.trim(), ...(status ? { status } : {}) }),
    onSuccess: done,
  });
  const remove = useMutation({ mutationFn: () => api.deleteCareer(entry.id), onSuccess: done });
  const [confirming, setConfirming] = useState(false);
  const slug = projects.find((p) => p.id === entry.projectId)?.slug;
  const lines = body.split('\n').length;

  return (
    <Panel>
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <h2 className="font-semibold">{entry.title}</h2>
        {slug && <Badge>#{slug}</Badge>}
        {entry.status === 'approved' ? (
          <Badge tone="accent">approved</Badge>
        ) : (
          <Badge tone="warn">draft</Badge>
        )}
        {entry.sourceVersionId && (
          <Link
            to="/reports/$versionId"
            params={{ versionId: entry.sourceVersionId }}
            className="text-sm text-muted underline hover:text-ink"
          >
            from the quarterly report
          </Link>
        )}
      </div>
      <textarea
        aria-label={`${entry.title} accomplishments`}
        rows={Math.min(Math.max(lines, 3), 14)}
        value={body}
        onChange={(e) => setBody(e.target.value)}
        className={`w-full font-mono ${inputClass}`}
      />
      {entry.warnings.length > 0 && !dirty && (
        <ul className="mt-2 space-y-0.5 text-sm text-warn">
          {entry.warnings.map((w) => (
            <li key={`${w.line}:${w.text}`}>
              Line {w.line}: “{w.text}” looks like {w.reason}. A public profile shouldn't carry it.
            </li>
          ))}
        </ul>
      )}
      {(save.error || remove.error) && <ErrorNote error={save.error ?? remove.error} />}
      <div className="mt-2 flex flex-wrap gap-2">
        {(dirty || entry.status === 'draft') && (
          <Button
            variant="primary"
            onClick={() => save.mutate('approved')}
            disabled={save.isPending}
          >
            {dirty ? 'Save and approve' : 'Approve'}
          </Button>
        )}
        {dirty && (
          <Button onClick={() => save.mutate(undefined)} disabled={save.isPending}>
            Save as draft
          </Button>
        )}
        {!dirty && entry.status === 'approved' && (
          <Button onClick={() => save.mutate('draft')} disabled={save.isPending}>
            Back to draft
          </Button>
        )}
        <Button
          variant="ghost"
          className="ml-auto text-muted"
          onClick={() => (confirming ? remove.mutate() : setConfirming(true))}
          onBlur={() => setConfirming(false)}
          disabled={remove.isPending}
        >
          {confirming ? 'Delete for good?' : 'Delete'}
        </Button>
      </div>
    </Panel>
  );
}
