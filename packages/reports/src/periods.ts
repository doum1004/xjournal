import { addDays, type ReportKind } from '@xjournal/core';

// Report periods (spec §5, §5.7): the start inclusive, the end exclusive, in the project's
// calendar. Weeks start on the workspace's week start (1 = Monday … 7 = Sunday); bi-weekly
// periods are pairs of weeks counted from an anchor week.

export interface Period {
  start: string;
  endExcl: string;
  title: string;
}

/** ISO weekday of a YYYY-MM-DD date: 1 = Monday … 7 = Sunday. */
export function isoWeekday(date: string): number {
  const d = new Date(`${date}T12:00:00Z`).getUTCDay();
  return d === 0 ? 7 : d;
}

const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

const daysBetween = (a: string, b: string) =>
  Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 86_400_000);

export function weekStartOf(date: string, weekStart = 1): string {
  return addDays(date, -((isoWeekday(date) - weekStart + 7) % 7));
}

export interface PeriodOptions {
  weekStart?: number;
  /** Any date in the first week of a bi-weekly pair. */
  biweeklyAnchor?: string;
}

export function periodFor(kind: ReportKind, date: string, opts: PeriodOptions = {}): Period {
  const weekStart = opts.weekStart ?? 1;
  const [y, m] = date.split('-').map(Number) as [number, number];
  const ym = (yy: number, mm: number) => `${yy}-${String(mm).padStart(2, '0')}-01`;
  switch (kind) {
    case 'daily':
      return {
        start: date,
        endExcl: addDays(date, 1),
        title: `${date} (${WEEKDAYS[isoWeekday(date) - 1]})`,
      };
    case 'weekly': {
      const start = weekStartOf(date, weekStart);
      return { start, endExcl: addDays(start, 7), title: `Week of ${start}` };
    }
    case 'biweekly': {
      const anchor = weekStartOf(opts.biweeklyAnchor ?? '2023-01-02', weekStart);
      const week = weekStartOf(date, weekStart);
      const offset = (((daysBetween(anchor, week) / 7) % 2) + 2) % 2;
      const start = addDays(week, -7 * offset);
      return { start, endExcl: addDays(start, 14), title: `Two weeks from ${start}` };
    }
    case 'monthly': {
      const next = m === 12 ? ym(y + 1, 1) : ym(y, m + 1);
      return { start: ym(y, m), endExcl: next, title: `${MONTHS[m - 1]} ${y}` };
    }
    case 'quarterly': {
      const q = Math.floor((m - 1) / 3);
      const start = ym(y, q * 3 + 1);
      const endExcl = q === 3 ? ym(y + 1, 1) : ym(y, q * 3 + 4);
      return { start, endExcl, title: `Q${q + 1} ${y}` };
    }
    case 'yearly':
      return { start: ym(y, 1), endExcl: ym(y + 1, 1), title: String(y) };
  }
}

/** The kind one level down that a period report is built from (spec §5). */
export function inputKindOf(kind: ReportKind): ReportKind | null {
  switch (kind) {
    case 'daily':
      return null;
    case 'weekly':
    case 'monthly':
      return 'daily';
    // Bi-weekly periods are always anchor-aligned pairs of weeks, so they're built from the
    // two weekly reports (spec §5.3).
    case 'biweekly':
      return 'weekly';
    case 'quarterly':
    case 'yearly':
      return 'monthly';
  }
}

/** The period just before `period` of the same kind. */
export function previousPeriod(kind: ReportKind, period: Period, opts: PeriodOptions = {}): Period {
  return periodFor(kind, addDays(period.start, -1), opts);
}

/** Kinds built (directly) from `kind`, for staleness propagation. */
export function parentKindsOf(kind: ReportKind): ReportKind[] {
  switch (kind) {
    case 'daily':
      return ['weekly', 'monthly'];
    case 'weekly':
      return ['biweekly'];
    case 'monthly':
      return ['quarterly', 'yearly'];
    default:
      return [];
  }
}
