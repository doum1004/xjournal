import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { api } from '../api';
import { ReportBody } from '../components/ReportView';
import { Badge, Empty, ErrorNote, Panel } from '../components/ui';
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
