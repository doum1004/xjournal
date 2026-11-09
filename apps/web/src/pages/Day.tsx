import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { api } from '../api';
import { RecordItem } from '../components/RecordItem';
import { Button, Empty, ErrorNote, Panel } from '../components/ui';
import { addDays, longDate, today } from '../dates';
import { useProject } from '../project';

// Day view (plan.md M1): one project's evidence for one date. The daily report and coverage
// appear here once bundles and reports exist (M2–M3).

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
