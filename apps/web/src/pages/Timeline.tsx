import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import type { DaySummary } from '@xjournal/core';
import { api } from '../api';
import { Button, Empty, ErrorNote, Panel } from '../components/ui';
import { addDays, longDate, today, weekday } from '../dates';
import { useProject } from '../project';

// Timeline (plan.md M1): a calendar heatmap of one year, then the most recent days.

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const level = (n: number) => (n === 0 ? 0 : n === 1 ? 1 : n === 2 ? 2 : n <= 4 ? 3 : 4);
const HEAT = ['bg-heat-0', 'bg-heat-1', 'bg-heat-2', 'bg-heat-3', 'bg-heat-4'];

export function TimelinePage({ year }: { year: number }) {
  const { project } = useProject();
  const navigate = useNavigate();
  const thisYear = new Date().getFullYear();
  const from = `${year}-01-01`;
  const to = `${year + 1}-01-01`;

  const days = useQuery({
    queryKey: ['days', project?.id, year],
    queryFn: () => api.days(project?.id as string, from, to),
    enabled: !!project,
  });

  if (!project) {
    return (
      <Empty>
        No projects yet. Create one with <code className="font-mono">hub project add</code>.
      </Empty>
    );
  }

  const byDate = new Map<string, DaySummary>((days.data?.items ?? []).map((d) => [d.date, d]));
  const total = [...byDate.values()].reduce((n, d) => n + d.recordCount, 0);
  const setYear = (y: number) => navigate({ to: '/', search: { year: y } });

  return (
    <div className="space-y-6">
      <Panel>
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-lg font-semibold">{year}</h1>
            <p className="text-sm text-muted">
              {days.isPending
                ? 'Loading…'
                : `${total} records on ${byDate.size} days in #${project.slug}`}
            </p>
          </div>
          <div className="flex gap-2">
            <Button onClick={() => setYear(year - 1)} aria-label="Previous year">
              ← {year - 1}
            </Button>
            <Button
              onClick={() => setYear(year + 1)}
              disabled={year >= thisYear}
              aria-label="Next year"
            >
              {year + 1} →
            </Button>
          </div>
        </div>
        {days.error ? <ErrorNote error={days.error} /> : <Heatmap year={year} byDate={byDate} />}
      </Panel>

      <Panel>
        <h2 className="mb-2 font-semibold">Most recent days</h2>
        <RecentDays byDate={byDate} />
      </Panel>
    </div>
  );
}

function Heatmap({ year, byDate }: { year: number; byDate: Map<string, DaySummary> }) {
  // Columns are weeks starting on Sunday; the first column holds Jan 1.
  const first = `${year}-01-01`;
  const start = addDays(first, -weekday(first));
  const end = `${year}-12-31`;
  const weeks: string[][] = [];
  for (let d = start; d <= end; d = addDays(d, 7)) {
    weeks.push(Array.from({ length: 7 }, (_, i) => addDays(d, i)));
  }
  const now = today();

  return (
    <div className="overflow-x-auto pb-1">
      <div
        className="inline-grid grid-flow-col gap-[3px]"
        style={{ gridTemplateRows: 'auto repeat(7, 12px)' }}
      >
        <div />
        {DAYS.map((d, i) => (
          <div key={d} className="pr-1 text-[10px] leading-3 text-muted">
            {i % 2 === 1 ? d : ''}
          </div>
        ))}
        {weeks.map((week) => {
          const firstOfMonth = week.find((d) => d.endsWith('-01') && d.startsWith(String(year)));
          return [
            <div key={`m${week[0]}`} className="h-4 text-[10px] text-muted">
              {firstOfMonth ? MONTHS[Number(firstOfMonth.slice(5, 7)) - 1] : ''}
            </div>,
            ...week.map((date) => {
              if (!date.startsWith(String(year)) || date > now) {
                return <div key={date} className="size-3" />;
              }
              const n = byDate.get(date)?.recordCount ?? 0;
              const label = `${longDate(date)}: ${n} record${n === 1 ? '' : 's'}`;
              return n === 0 ? (
                <div key={date} title={label} className={`size-3 rounded-[2px] ${HEAT[0]}`} />
              ) : (
                <Link
                  key={date}
                  to="/day/$date"
                  params={{ date }}
                  title={label}
                  aria-label={label}
                  className={`size-3 rounded-[2px] ${HEAT[level(n)]} hover:ring-2 hover:ring-accent`}
                />
              );
            }),
          ];
        })}
      </div>
      <div className="mt-2 flex items-center gap-1 text-[10px] text-muted">
        Less
        {HEAT.map((c) => (
          <span key={c} className={`size-3 rounded-[2px] ${c}`} />
        ))}
        More
      </div>
    </div>
  );
}

function RecentDays({ byDate }: { byDate: Map<string, DaySummary> }) {
  const recent = [...byDate.values()].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 14);
  if (recent.length === 0) return <Empty>Nothing recorded this year.</Empty>;
  return (
    <ul className="divide-y divide-line">
      {recent.map((d) => (
        <li key={d.date}>
          <Link
            to="/day/$date"
            params={{ date: d.date }}
            className="flex items-center justify-between py-2 text-sm hover:text-accent"
          >
            <span>{longDate(d.date)}</span>
            <span className="text-muted tabular-nums">
              {d.recordCount} record{d.recordCount === 1 ? '' : 's'}
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}
