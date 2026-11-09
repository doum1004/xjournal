import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { api } from '../api';
import { ReportBody } from '../components/ReportView';
import { Badge, Button, Empty, ErrorNote, inputClass, Panel } from '../components/ui';
import { addDays, today } from '../dates';
import { useProject } from '../project';

// Reports (plan.md M3): what's due, then the project's reports of the last few months.
// Read-only here; agents (MCP) write them, and the UI can generate them from M4.

const KIND_ORDER = ['weekly', 'biweekly', 'monthly', 'quarterly', 'yearly', 'daily'];

export function ReportsPage() {
  const { project } = useProject();
  const from = addDays(today(), -120);
  const to = addDays(today(), 1);
  const reports = useQuery({
    queryKey: ['reports', project?.id, from],
    queryFn: () => api.reports(project?.id as string, from, to),
    enabled: !!project,
  });
  const status = useQuery({
    queryKey: ['status', project?.id],
    queryFn: () => api.status(project?.id),
  });
  if (!project) return <Empty>No project selected.</Empty>;

  const items = (reports.data?.items ?? []).filter((r) => r.currentVersionId);
  const byKind = new Map<string, typeof items>();
  for (const r of items) byKind.set(r.kind, [...(byKind.get(r.kind) ?? []), r]);

  return (
    <div className="space-y-4">
      <Panel>
        <h1 className="text-lg font-semibold">Reports · #{project.slug}</h1>
        {status.data && (
          <div className="mt-2 text-sm">
            {status.data.due.length === 0 ? (
              <p className="text-muted">
                Nothing due: every weekday with evidence has a current report.
              </p>
            ) : (
              <>
                <p className="text-muted">
                  Due for the next morning run ({status.data.due.length}). Ask your agent to “run my
                  morning work log” (the <code className="font-mono">morning_run</code> prompt).
                </p>
                <ul className="mt-1 flex flex-wrap gap-2">
                  {status.data.due.map((d) => (
                    <li key={`${d.kind}${d.date}${d.projectId}`}>
                      <Badge tone={d.reason === 'stale' ? 'warn' : 'muted'}>
                        {d.kind} {d.date} · {d.reason}
                      </Badge>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>
        )}
      </Panel>
      {status.data && status.data.due.length > 0 && <WriteDue projectId={project.id} />}
      <div className="grid gap-4 md:grid-cols-2">
        <Stats projectId={project.id} />
        <Guidance projectId={project.id} />
      </div>
      {reports.error && <ErrorNote error={reports.error} />}
      {[...byKind.entries()]
        .sort(([a], [b]) => KIND_ORDER.indexOf(a) - KIND_ORDER.indexOf(b))
        .map(([kind, list]) => (
          <Panel key={kind}>
            <h2 className="mb-2 font-semibold capitalize">{kind}</h2>
            <ul className="divide-y divide-line">
              {[...list]
                .sort((a, b) => b.period.start.localeCompare(a.period.start))
                .slice(0, kind === 'daily' ? 30 : 20)
                .map((r) => (
                  <li
                    key={r.reportId}
                    className="flex items-center justify-between gap-2 py-1.5 text-sm"
                  >
                    <Link
                      to="/reports/$versionId"
                      params={{ versionId: r.currentVersionId as string }}
                      className="hover:text-accent"
                    >
                      {r.period.title}
                    </Link>
                    <span className="flex items-center gap-2 text-xs text-muted">
                      {r.path === 'import' && <span>imported</span>}
                      {r.status === 'stale' && <Badge tone="warn">out of date</Badge>}
                      <span>v{r.versionNo}</span>
                    </span>
                  </li>
                ))}
            </ul>
          </Panel>
        ))}
      {reports.data && items.length === 0 && (
        <Panel>
          <Empty>No reports yet.</Empty>
        </Panel>
      )}
    </div>
  );
}

export function ReportPage({ versionId }: { versionId: string }) {
  const v = useQuery({
    queryKey: ['report-version', versionId],
    queryFn: () => api.reportVersion(versionId),
  });
  if (v.error) return <ErrorNote error={v.error} />;
  if (!v.data) return <Empty>Loading…</Empty>;
  return (
    <Panel>
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-lg font-semibold">
          <span className="capitalize">{v.data.kind}</span> · {v.data.period.title}
        </h1>
        {v.data.kind === 'daily' && (
          <Link
            to="/day/$date"
            params={{ date: v.data.period.start }}
            className="text-sm text-accent hover:underline"
          >
            The day’s evidence →
          </Link>
        )}
      </div>
      <ReportBody v={v.data} />
    </Panel>
  );
}

function WriteDue({ projectId }: { projectId: string }) {
  const qc = useQueryClient();
  const ai = useQuery({ queryKey: ['ai'], queryFn: api.ai });
  const refresh = useMutation({
    mutationFn: () => api.refreshReports(projectId),
    onSuccess: () => {
      const again = () => {
        for (const k of ['reports', 'status', 'days', 'day'])
          qc.invalidateQueries({ queryKey: [k] });
      };
      again();
      for (const ms of [10000, 30000, 60000, 120000]) setTimeout(again, ms);
    },
  });
  if (!ai.data?.hasKey) {
    return (
      <Panel>
        <p className="text-sm text-muted">
          To write these here without an agent, add a Claude API key in Settings → AI.
        </p>
      </Panel>
    );
  }
  const r = refresh.data as
    | { queued?: number; due?: number; written?: unknown[]; failed?: { error: string }[] }
    | undefined;
  return (
    <Panel>
      <div className="flex flex-wrap items-center gap-3">
        <Button variant="primary" onClick={() => refresh.mutate()} disabled={refresh.isPending}>
          {refresh.isPending ? 'Writing…' : 'Write all due reports'}
        </Button>
        <span className="text-sm text-muted">
          The hub writes them with its own model call, oldest first.
        </span>
      </div>
      {refresh.error && <ErrorNote error={refresh.error} />}
      {r?.queued != null && (
        <p className="mt-2 text-sm text-muted">
          {r.queued} of {r.due} queued; they appear below as they are written.
        </p>
      )}
      {r?.written && <p className="mt-2 text-sm text-muted">Wrote {r.written.length}.</p>}
      {r?.failed?.map((f) => (
        <ErrorNote key={f.error} error={f.error} />
      ))}
    </Panel>
  );
}

const METRICS: [string, string][] = [
  ['prs_merged', 'PRs merged'],
  ['prs_opened', 'PRs opened'],
  ['reviews', 'Reviews given'],
  ['commits', 'Commits'],
  ['issues_created', 'Issues created'],
  ['issue_changes', 'Issue changes'],
  ['pages_edited', 'Pages edited'],
  ['notes', 'Notes'],
  ['active_days', 'Active days'],
];

function Stats({ projectId }: { projectId: string }) {
  const t = today();
  const week = useQuery({
    queryKey: ['stats', projectId, 7],
    queryFn: () => api.stats(projectId, addDays(t, -7), addDays(t, 1)),
  });
  const month = useQuery({
    queryKey: ['stats', projectId, 30],
    queryFn: () => api.stats(projectId, addDays(t, -30), addDays(t, 1)),
  });
  const value = (q: typeof week, m: string) =>
    q.data?.items.find((x) => x.metric === m)?.value ?? '—';
  return (
    <Panel>
      <h2 className="mb-2 font-semibold">Your numbers</h2>
      <table className="w-full text-sm">
        <thead className="text-xs text-muted">
          <tr>
            <th className="py-1 text-left font-normal">Metric</th>
            <th className="py-1 text-right font-normal">7 days</th>
            <th className="py-1 text-right font-normal">30 days</th>
          </tr>
        </thead>
        <tbody>
          {METRICS.map(([m, label]) => (
            <tr key={m} className="border-t border-line">
              <td className="py-1">{label}</td>
              <td className="py-1 text-right tabular-nums">{value(week, m)}</td>
              <td className="py-1 text-right tabular-nums">{value(month, m)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-2 text-xs text-muted">Counted from the evidence, as reports cite them.</p>
    </Panel>
  );
}

function Guidance({ projectId }: { projectId: string }) {
  const qc = useQueryClient();
  const g = useQuery({ queryKey: ['guidance', projectId], queryFn: () => api.guidance(projectId) });
  const [text, setText] = useState('');
  const [scope, setScope] = useState('project');
  const done = () => {
    qc.invalidateQueries({ queryKey: ['guidance'] });
    qc.invalidateQueries({ queryKey: ['status'] });
  };
  const add = useMutation({
    mutationFn: () =>
      api.addGuidance(
        scope.startsWith('kind:')
          ? { scope: 'report_kind', reportKind: scope.slice(5), projectId, text: text.trim() }
          : scope === 'workspace'
            ? { scope: 'workspace', text: text.trim() }
            : { scope: 'project', projectId, text: text.trim() },
      ),
    onSuccess: () => {
      setText('');
      done();
    },
  });
  const archive = useMutation({
    mutationFn: (id: string) => api.archiveGuidance(id),
    onSuccess: done,
  });
  const label = (x: { scope: string; reportKind: string | null }) =>
    x.scope === 'report_kind' ? `${x.reportKind} reports` : x.scope;
  return (
    <Panel>
      <h2 className="mb-1 font-semibold">Guidance</h2>
      <p className="mb-2 text-xs text-muted">
        Instructions every future report follows, without changing evidence. The most specific wins.
      </p>
      {g.error && <ErrorNote error={g.error} />}
      <ul className="mb-3 divide-y divide-line text-sm">
        {g.data?.items.map((x) => (
          <li key={x.id} className="flex items-start justify-between gap-2 py-1.5">
            <span>
              <Badge>{label(x)}</Badge> {x.text}
            </span>
            <Button
              variant="ghost"
              className="px-2 py-0.5 text-xs"
              onClick={() => archive.mutate(x.id)}
            >
              Remove
            </Button>
          </li>
        ))}
        {g.data?.items.length === 0 && <li className="py-1 text-muted">None yet.</li>}
      </ul>
      <form
        className="space-y-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (text.trim()) add.mutate();
        }}
      >
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={2}
          placeholder="e.g. Leave out routine standups. Lead with what shipped."
          className={`w-full ${inputClass}`}
        />
        <div className="flex gap-2">
          <select
            aria-label="Applies to"
            value={scope}
            onChange={(e) => setScope(e.target.value)}
            className={inputClass}
          >
            <option value="project">this project</option>
            <option value="kind:daily">daily reports</option>
            <option value="kind:weekly">weekly reports</option>
            <option value="kind:monthly">monthly reports</option>
            <option value="workspace">every project</option>
          </select>
          <Button type="submit" variant="primary" disabled={!text.trim() || add.isPending}>
            Add
          </Button>
        </div>
        {(add.error || archive.error) && <ErrorNote error={add.error ?? archive.error} />}
      </form>
    </Panel>
  );
}
