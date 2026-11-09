import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { isIsoDate, type RecordInput, SUMMARY_MAX, startOfDay } from '@xjournal/core';

// The prototype's ~/worklog folder (schema.md §11, spec Appendix A).
//
//   daily/YYYY/YYYY-MM-DD.md   front matter {date, source}, "# YYYY-MM-DD (Weekday)", Markdown
//   reviews/<kind>/*.md        front matter {kind, start, end, title}  → report versions (M3)
//   raw/*.json                 discarded; the connectors re-collect what history allows
//
// A daily log becomes one `imported_log` record per day. Logs that came from the Confluence
// work log keep `source = 'confluence:worklog'`, so the Confluence import connector later
// updates the same records instead of duplicating them.

export interface WorklogRecord {
  source: string;
  file: string;
  input: RecordInput;
}

export interface WorklogScan {
  daily: WorklogRecord[];
  /** Review files found; they become report versions once reports exist (M3). */
  reviews: string[];
  skipped: { file: string; reason: string }[];
}

const TITLE_LEN = 120;
const JIRA_KEY_RE = /\b[A-Z][A-Z0-9]{1,9}-\d+\b/g;
const URL_RE = /https?:\/\/[^\s)>\]]+/g;

export function parseFrontMatter(text: string): { meta: Record<string, string>; body: string } {
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text);
  if (!m) return { meta: {}, body: text };
  const meta: Record<string, string> = {};
  for (const line of (m[1] as string).split('\n')) {
    const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (kv) meta[kv[1] as string] = (kv[2] as string).replace(/^(['"])(.*)\1$/, '$2').trim();
  }
  return { meta, body: m[2] as string };
}

function sourceFor(meta: Record<string, string>): string {
  return meta.source === 'confluence-import' ? 'confluence:worklog' : 'file:worklog';
}

/** First readable line of a log: bullet and heading markers removed. */
function firstLine(body: string): string | undefined {
  for (const raw of body.split('\n')) {
    const line = raw
      .replace(/^\s*(?:[-*+]|\d+\.)\s+/, '')
      .replace(/^#+\s+/, '')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .trim();
    if (line) return line;
  }
  return undefined;
}

const clip = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, n - 1).trimEnd()}…`);
const unique = (xs: Iterable<string>) => [...new Set(xs)];

/**
 * One daily log → the record contract. `timeZone` places the day's start (the event time);
 * the applicable date is the log's own date.
 */
export function parseDailyLog(
  text: string,
  file: string,
  timeZone: string,
): { ok: true; record: WorklogRecord } | { ok: false; reason: string } {
  const { meta, body: rawBody } = parseFrontMatter(text.replace(/\r\n/g, '\n'));
  const fromName = /(\d{4}-\d{2}-\d{2})\.md$/.exec(file)?.[1];
  const date = meta.date && isIsoDate(meta.date) ? meta.date : fromName;
  if (!date || !isIsoDate(date)) return { ok: false, reason: 'no valid date' };

  // Drop the "# YYYY-MM-DD (Weekday)" heading: the date is already the record's date.
  const body = rawBody.replace(new RegExp(`^\\s*#\\s+${date}[^\\n]*\\n?`), '').trim();
  if (!body) return { ok: false, reason: 'empty log' };

  return {
    ok: true,
    record: {
      source: sourceFor(meta),
      file,
      input: dayLogInput(date, body, timeZone, {
        file,
        ...(Object.keys(meta).length ? { frontMatter: meta } : {}),
      }),
    },
  };
}

/**
 * A day's work log as a record: one `imported_log` per date, titled by its first line.
 * Shared by the file import and the Confluence import, so both describe a day the same way.
 */
export function dayLogInput(
  date: string,
  body: string,
  timeZone: string,
  provenance: Record<string, unknown>,
  url?: string,
): RecordInput {
  const title = clip(firstLine(body) ?? `Work log ${date}`, TITLE_LEN);
  const summary = body.length > title.length ? clip(body, SUMMARY_MAX) : undefined;
  const jira = unique(body.match(JIRA_KEY_RE) ?? []);
  const urls = unique(body.match(URL_RE) ?? []);
  return {
    externalId: date,
    kind: 'imported_log',
    eventTime: startOfDay(date, timeZone).toISOString(),
    applicableDate: date,
    title,
    ...(summary ? { summary } : {}),
    ...(url ? { url } : {}),
    actor: 'worklog',
    payload: {
      text: body,
      ...provenance,
      ...(jira.length || urls.length ? { refs: { jira, urls } } : {}),
    },
  };
}

function walk(dir: string): string[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names.sort().flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

/** Read a worklog folder. Paths in the result are relative to `root`, with `/` separators. */
export function scanWorklog(root: string, timeZone: string): WorklogScan {
  if (!statSync(root, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error(`Not a folder: ${root}`);
  }
  const rel = (p: string) => relative(root, p).split('\\').join('/');
  const scan: WorklogScan = { daily: [], reviews: [], skipped: [] };
  for (const path of walk(join(root, 'daily'))) {
    if (!path.endsWith('.md')) continue;
    const r = parseDailyLog(readFileSync(path, 'utf8'), rel(path), timeZone);
    if (r.ok) scan.daily.push(r.record);
    else scan.skipped.push({ file: rel(path), reason: r.reason });
  }
  // Two files for one date (e.g. a copy in another year folder): keep the first, report the rest.
  const seen = new Set<string>();
  scan.daily = scan.daily.filter((d) => {
    const key = `${d.source}|${d.input.externalId}`;
    if (!seen.has(key)) return seen.add(key);
    scan.skipped.push({ file: d.file, reason: `duplicate date ${d.input.externalId}` });
    return false;
  });
  scan.reviews = walk(join(root, 'reviews'))
    .filter((p) => p.endsWith('.md'))
    .map(rel);
  return scan;
}
