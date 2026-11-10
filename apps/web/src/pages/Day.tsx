import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import type { DayView } from '@xjournal/core';
import { api } from '../api';
import { RecordItem } from '../components/RecordItem';
import { ReportBody, useGenerate } from '../components/ReportView';
import { Badge, Button, Empty, ErrorNote, Panel } from '../components/ui';
import { addDays, longDate, today } from '../dates';
import { useProject } from '../project';

// Day view (plan.md M1–M2): one project's evidence for one date, its bundle and each
// connector's coverage of the day. The daily report joins it in M3; work items (spec §3.5)
// group the records in M6.

/** Distinct records of the day: one in several work items is listed under each. */
const recordCount = (day: DayView) =>
  new Set([...day.workItems.flatMap((w) => w.records), ...day.unlinked].map((r) => r.id)).size;

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
  if (!day.bundle && coverage.length === 0 && recordCount(day) === 0) return null;
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
  const count = day.data ? recordCount(day.data) : 0;
  const items = day.data?.workItems ?? [];
  const records = day.data?.unlinked ?? [];

  return (
    <Panel>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold">{longDate(date)}</h1>
          <p className="text-sm text-muted">
            #{project.slug} ·{' '}
            {day.isPending
              ? 'loading…'
              : `${count} records${items.length ? ` · ${items.length} work items` : ''}`}
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
      {day.data?.daily?.versionId ? (
        <DailyReport versionId={day.data.daily.versionId} />
      ) : day.data && count > 0 ? (
        <WriteDaily projectId={project.id} date={date} />
      ) : null}
      {day.error ? (
        <ErrorNote error={day.error} />
      ) : count === 0 && !day.isPending ? (
        <Empty>Nothing recorded for this day.</Empty>
      ) : (
        <>
          {items.map((w) => (
            <section key={w.id} className="mb-3 rounded-md border border-line px-3 pt-2">
              <h2 className="flex flex-wrap items-baseline gap-2 text-sm font-semibold">
                {w.url ? (
                  <a href={w.url} className="hover:text-accent hover:underline">
                    {w.title}
                  </a>
                ) : (
                  w.title
                )}
                <Badge>{w.records.length} records</Badge>
              </h2>
              <ul>
                {w.records.map((r) => (
                  <RecordItem key={r.id} record={r} />
                ))}
              </ul>
            </section>
          ))}
          {items.length > 0 && records.length > 0 && (
            <h2 className="mt-4 text-sm font-semibold text-muted">Other records</h2>
          )}
          <ul>
            {records.map((r) => (
              <RecordItem key={r.id} record={r} />
            ))}
          </ul>
        </>
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

function WriteDaily({ projectId, date }: { projectId: string; date: string }) {
  const ai = useQuery({ queryKey: ['ai'], queryFn: api.ai });
  const resolve = useMutation({ mutationFn: () => api.resolveReport(projectId, 'daily', date) });
  const generate = useGenerate(resolve.data?.reportId);
  const busy = resolve.isPending || generate.isPending;
  return (
    <section className="mb-4 flex flex-wrap items-center gap-3 rounded-md border border-dashed border-line p-3 text-sm">
      <span className="text-muted">No daily report for this day yet.</span>
      {ai.data?.hasKey ? (
        <Button
          variant="primary"
          disabled={busy}
          onClick={async () => {
            const r = await resolve.mutateAsync();
            generate.mutate({ reportId: r.reportId });
          }}
        >
          {busy ? 'Writing…' : 'Write the daily report'}
        </Button>
      ) : (
        <span className="text-muted">
          Ask your agent to “run my morning work log”, or add a Claude API key in Settings → AI to
          write it here.
        </span>
      )}
      {(resolve.error || generate.error) && <ErrorNote error={resolve.error ?? generate.error} />}
      {generate.data && 'queued' in generate.data && (
        <span className="text-muted">Writing in the background…</span>
      )}
    </section>
  );
}
