import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import type { DayView } from '@xjournal/core';
import { api } from '../api';
import { RecordItem } from '../components/RecordItem';
import { ReportBody } from '../components/ReportView';
import { Badge, Button, Empty, ErrorNote, Panel } from '../components/ui';
import { addDays, longDate, today } from '../dates';
import { useProject } from '../project';

// Day view (plan.md M1–M2): one project's evidence for one date, its bundle and each
// connector's coverage of the day. The daily report joins it in M3.

const COVERAGE_TONE = {
  complete: 'accent',
  pending: 'muted',
  error: 'warn',
  truncated: 'warn',
} as const;
const COVERAGE_TEXT = {
  complete: 'complete',
  pending: 'not synced past this day yet',
  error: 'last sync failed',
  truncated: 'history starts later',
} as const;

function BundleStrip({ day, projectId }: { day: DayView; projectId: string }) {
  const qc = useQueryClient();
  const rebuild = useMutation({
    mutationFn: () => api.rebuildDay(projectId, day.date),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['day'] }),
  });
  const coverage = Object.entries(day.coverage);
  if (!day.bundle && coverage.length === 0 && day.unlinked.length === 0) return null;
  return (
    <div className="mb-3 flex flex-wrap items-center gap-2 text-xs text-muted">
      {day.bundle ? (
        <span
          title={`Bundle ${day.bundle.hash}, built ${new Date(day.bundle.builtAt).toLocaleString()}`}
        >
          Bundle <span className="font-mono">{day.bundle.hash.slice(0, 8)}</span>
          {day.bundle.dirty && (
            <>
              {' '}
              <Badge tone="warn">out of date</Badge>
            </>
          )}
        </span>
      ) : (
        <Badge tone="warn">no bundle yet</Badge>
      )}
      {(!day.bundle || day.bundle.dirty) && (
        <Button
          variant="ghost"
          className="px-2 py-0.5 text-xs"
          onClick={() => rebuild.mutate()}
          disabled={rebuild.isPending}
        >
          Rebuild
        </Button>
      )}
      {coverage.map(([id, c]) => (
        <span
          key={id}
          title={c.truncatedBefore ? `Nothing before ${c.truncatedBefore}` : undefined}
        >
          <Badge tone={COVERAGE_TONE[c.status]}>
            {c.source}: {COVERAGE_TEXT[c.status]}
          </Badge>
        </span>
      ))}
      {rebuild.error && <ErrorNote error={rebuild.error} />}
    </div>
  );
}

export function DayPage({
  date,
  onAddNote,
}: {
  date: string;
  onAddNote: (prefill: string) => void;
}) {
  const { project } = useProject();
  const day = useQuery({
    queryKey: ['day', project?.id, date],
    queryFn: () => api.day(project?.id as string, date),
    enabled: !!project,
  });
  if (!project) return <Empty>No project selected.</Empty>;

  const prev = addDays(date, -1);
  const next = addDays(date, 1);
  const records = day.data?.unlinked ?? [];

  return (
    <Panel>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold">{longDate(date)}</h1>
          <p className="text-sm text-muted">
            #{project.slug} · {day.isPending ? 'loading…' : `${records.length} records`}
          </p>
        </div>
        <div className="flex gap-2">
          <Link
            to="/day/$date"
            params={{ date: prev }}
            className="rounded-md border border-line px-3 py-1.5 text-sm hover:bg-bg"
          >
            ← Previous
          </Link>
          {next <= today() && (
            <Link
              to="/day/$date"
              params={{ date: next }}
              className="rounded-md border border-line px-3 py-1.5 text-sm hover:bg-bg"
            >
              Next →
            </Link>
          )}
          <Button variant="primary" onClick={() => onAddNote(`#${project.slug} @${date} `)}>
            Add note for this day
          </Button>
        </div>
      </div>
      {day.data && <BundleStrip day={day.data} projectId={project.id} />}
      {day.data?.daily?.versionId && <DailyReport versionId={day.data.daily.versionId} />}
      {day.error ? (
        <ErrorNote error={day.error} />
      ) : records.length === 0 && !day.isPending ? (
        <Empty>Nothing recorded for this day.</Empty>
      ) : (
        <ul>
          {records.map((r) => (
            <RecordItem key={r.id} record={r} />
          ))}
        </ul>
      )}
    </Panel>
  );
}

function DailyReport({ versionId }: { versionId: string }) {
  const v = useQuery({
    queryKey: ['report-version', versionId],
    queryFn: () => api.reportVersion(versionId),
  });
  if (!v.data) return null;
  return (
    <section className="mb-4 rounded-md border border-line p-3">
      <h2 className="mb-2 text-sm font-semibold">Daily report</h2>
      <ReportBody v={v.data} compact />
    </section>
  );
}
