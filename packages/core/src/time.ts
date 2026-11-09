// Calendar and time-zone rules (spec §5.7): instants are UTC; the project's time zone decides
// which calendar day an instant falls on.

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    // en-CA formats dates as YYYY-MM-DD.
    f = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    formatters.set(timeZone, f);
  }
  return f;
}

export function isTimeZone(value: string): boolean {
  try {
    formatter(value);
    return true;
  } catch {
    return false;
  }
}

/** The calendar date (`YYYY-MM-DD`) of `instant` in `timeZone`. */
export function localDate(instant: Date, timeZone: string): string {
  return formatter(timeZone).format(instant);
}

/** `date` plus `days` calendar days. Pure date arithmetic, no time zone involved. */
export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** True for a real calendar date in `YYYY-MM-DD` form (rejects `2026-02-30`). */
export function isIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  return new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
}

/** The time zone of this machine, for local-mode defaults. */
export function systemTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

/** The offset of `timeZone` from UTC at `instant`, in milliseconds (positive east of UTC). */
function zoneOffsetMs(instant: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(instant));
  const n = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const asUtc = Date.UTC(n('year'), n('month') - 1, n('day'), n('hour'), n('minute'), n('second'));
  return asUtc - Math.floor(instant / 1000) * 1000;
}

/** The instant a calendar day starts in `timeZone` (handles DST changes). */
export function startOfDay(date: string, timeZone: string): Date {
  const guess = Date.parse(`${date}T00:00:00Z`);
  let t = guess - zoneOffsetMs(guess, timeZone);
  // A second pass corrects the guess when the offset differs at the real instant (DST).
  t = guess - zoneOffsetMs(t, timeZone);
  return new Date(t);
}
