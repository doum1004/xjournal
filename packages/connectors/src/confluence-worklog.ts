import { addDays, isIsoDate } from '@xjournal/core';
import { dayLogInput, type WorklogRecord } from './worklog';

// The Confluence work log (spec §14 item 2, schema.md §11): one page per month, titled
// "<Month>, <YYYY>", holding a table with one row per day:
//
//   <tr><td>… <time datetime="YYYY-MM-DD" /> …</td><td>… the day's log (storage XHTML) …</td></tr>
//
// Read-only here. Records use source 'confluence:worklog' and the date as external ID, the
// same keys as the ~/worklog file import, so importing both updates one record per day.

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

/** "November, 2026" for 2026-11-xx. */
export function monthTitle(date: string): string {
  return `${MONTHS[Number(date.slice(5, 7)) - 1]}, ${date.slice(0, 4)}`;
}

/** Month page titles to read for a date range, plus the month before `from` (rows near a
 *  month boundary sometimes sit on the previous month's page). */
export function monthTitlesFor(from: string, to: string): string[] {
  const titles: string[] = [];
  let d = addDays(`${from.slice(0, 7)}-01`, -1).slice(0, 7);
  const last = to.slice(0, 7);
  while (d <= last) {
    titles.push(monthTitle(`${d}-01`));
    const [y, m] = d.split('-').map(Number) as [number, number];
    d = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
  }
  return titles;
}

// ------------------------------------------------------------------------------------------
// Storage format → text (ported from the prototype's converter, so the output matches the
// ~/worklog files it wrote)
// ------------------------------------------------------------------------------------------

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '–',
  mdash: '—',
  hellip: '…',
  rsquo: '’',
  lsquo: '‘',
  rdquo: '”',
  ldquo: '“',
};

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code =
        e[1] === 'x' || e[1] === 'X' ? Number.parseInt(e.slice(2), 16) : Number(e.slice(1));
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

function attrs(src: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of src.matchAll(/([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) {
    out[(m[1] as string).toLowerCase()] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? '');
  }
  return out;
}

const TOKEN_RE =
  /<!\[CDATA\[([\s\S]*?)\]\]>|<!--[\s\S]*?-->|<(\/?)([a-zA-Z][\w:.-]*)((?:\s+[^>]*?)?)\s*(\/?)>|([^<]+)|</g;

/** Confluence storage XHTML → plain text with Markdown-style lists, headings and links. */
export function storageToText(storage: string): string {
  const out: string[] = [];
  const macros: (string | undefined)[] = [];
  let depth = 0;
  let param: string | null = null;
  let href: string | null = null;

  const start = (tag: string, a: Record<string, string>) => {
    if (tag === 'ac:structured-macro') macros.push(a['ac:name']);
    else if (tag === 'ac:parameter') param = a['ac:name'] ?? null;
    else if (tag === 'ul' || tag === 'ol') depth++;
    else if (tag === 'li') out.push('\n', `${'  '.repeat(Math.max(depth - 1, 0))}- `);
    else if (['p', 'tr', 'br', 'div'].includes(tag)) {
      // `<li><p>text</p>` keeps the text on the bullet line. (The prototype started a new
      // line here, which left a bare "-" in its files.)
      if (!out.at(-1)?.endsWith('- ')) out.push('\n');
    } else if (/^h\d$/.test(tag)) out.push('\n', `${'#'.repeat(Math.min(Number(tag[1]) + 1, 6))} `);
    else if (tag === 'strong' || tag === 'b') out.push('**');
    else if (tag === 'code') out.push('`');
    else if (tag === 'a') href = a.href ?? null;
    else if (tag === 'time') out.push(a.datetime ?? '');
  };
  const end = (tag: string) => {
    if (tag === 'ac:structured-macro') macros.pop();
    else if (tag === 'ac:parameter') param = null;
    else if (tag === 'ul' || tag === 'ol') depth--;
    else if (tag === 'strong' || tag === 'b') out.push('**');
    else if (tag === 'code') out.push('`');
    else if (tag === 'a') {
      if (href?.startsWith('http')) out.push(` <${href}>`);
      href = null;
    }
  };
  const text = (data: string) => {
    if (macros.at(-1) === 'jira') {
      if (param === 'key') out.push(`[${data.trim()}]`);
      return;
    }
    if (param) return;
    out.push(data);
  };

  for (const m of storage.matchAll(TOKEN_RE)) {
    if (m[1] !== undefined) out.push(m[1]);
    else if (m[3] !== undefined) {
      const tag = m[3].toLowerCase();
      if (m[2]) end(tag);
      else {
        start(tag, attrs(m[4] ?? ''));
        if (m[5]) end(tag);
      }
    } else if (m[6] !== undefined) text(decodeEntities(m[6]));
    else if (m[0] === '<') text('<');
  }

  return out
    .join('')
    .replace(/ /g, ' ')
    .split(/\r?\n/)
    .map((l) => l.trimEnd())
    .filter((l) => l.trim() !== '' && l.trim() !== '****')
    .join('\n')
    .trim();
}

// ------------------------------------------------------------------------------------------
// Month pages → day rows
// ------------------------------------------------------------------------------------------

const ROW_RE = /<tr>(?:(?!<\/tr>)[\s\S])*?<\/tr>/g;
const TIME_RE = /<time datetime="(\d{4}-\d{2}-\d{2})"/;

/** The log cell of one table row: the second `<td>`, without its content-wrapper div. */
export function cellOf(rowHtml: string): string {
  const parts = rowHtml.split(/<\/td>/);
  if (parts.length < 2) return '';
  return parts
    .slice(1)
    .join('</td>')
    .replace(/^\s*<td[^>]*>/, '')
    .replace(/<\/td>\s*<\/tr>\s*$/, '')
    .replace(/<\/tr>\s*$/, '')
    .replace(/^\s*<div class="content-wrapper">/, '')
    .replace(/<\/div>\s*$/, '');
}

/** Each dated row on a month page, as text. Empty rows are left out. */
export function rowsOf(pageBody: string): { date: string; text: string }[] {
  const rows: { date: string; text: string }[] = [];
  for (const m of pageBody.matchAll(ROW_RE)) {
    const date = TIME_RE.exec(m[0])?.[1];
    if (!date || !isIsoDate(date)) continue;
    const text = storageToText(cellOf(m[0]));
    if (text) rows.push({ date, text });
  }
  return rows;
}

// ------------------------------------------------------------------------------------------
// REST client (Confluence Server / Data Center, REST API v1)
// ------------------------------------------------------------------------------------------

export interface ConfluenceConfig {
  /** e.g. https://wiki.example.com — no trailing slash. */
  baseUrl: string;
  spaceKey: string;
  /** Personal access token (Bearer), or an API token used with `user` (Basic). */
  token: string;
  user?: string;
  fetch?: typeof fetch;
}

export interface MonthPage {
  id: string;
  title: string;
  version: number;
  url: string;
  body: string;
}

export async function findMonthPage(
  cfg: ConfluenceConfig,
  title: string,
): Promise<MonthPage | null> {
  const base = cfg.baseUrl.replace(/\/+$/, '');
  const q = new URLSearchParams({ spaceKey: cfg.spaceKey, title, expand: 'body.storage,version' });
  const res = await (cfg.fetch ?? fetch)(`${base}/rest/api/content?${q}`, {
    headers: {
      accept: 'application/json',
      authorization: cfg.user
        ? `Basic ${Buffer.from(`${cfg.user}:${cfg.token}`).toString('base64')}`
        : `Bearer ${cfg.token}`,
    },
  });
  if (!res.ok) {
    throw new Error(`Confluence: HTTP ${res.status} reading "${title}"`);
  }
  const json = (await res.json()) as {
    results?: {
      id: string;
      title: string;
      version?: { number?: number };
      body?: { storage?: { value?: string } };
      _links?: { webui?: string };
    }[];
  };
  const p = json.results?.[0];
  if (!p) return null;
  return {
    id: p.id,
    title: p.title,
    version: p.version?.number ?? 0,
    url: `${base}${p._links?.webui ?? `/pages/viewpage.action?pageId=${p.id}`}`,
    body: p.body?.storage?.value ?? '',
  };
}

export interface ConfluenceWorklogScan {
  records: WorklogRecord[];
  pagesRead: string[];
  pagesMissing: string[];
}

/**
 * Read the month pages covering `from`…`to` (inclusive) and turn each non-empty day row
 * into a record. A date that appears on two pages has its texts joined, as the prototype did.
 */
export async function scanConfluenceWorklog(
  cfg: ConfluenceConfig,
  range: { from: string; to: string },
  timeZone: string,
): Promise<ConfluenceWorklogScan> {
  if (!isIsoDate(range.from) || !isIsoDate(range.to) || range.from > range.to) {
    throw new Error('Expected --from and --to as YYYY-MM-DD, with from ≤ to');
  }
  const days = new Map<string, { text: string; page: MonthPage }>();
  const scan: ConfluenceWorklogScan = { records: [], pagesRead: [], pagesMissing: [] };
  for (const title of monthTitlesFor(range.from, range.to)) {
    const page = await findMonthPage(cfg, title);
    if (!page) {
      scan.pagesMissing.push(title);
      continue;
    }
    scan.pagesRead.push(title);
    for (const row of rowsOf(page.body)) {
      if (row.date < range.from || row.date > range.to) continue;
      const seen = days.get(row.date);
      days.set(
        row.date,
        seen ? { ...seen, text: `${seen.text}\n${row.text}` } : { text: row.text, page },
      );
    }
  }
  for (const [date, { text, page }] of [...days].sort(([a], [b]) => a.localeCompare(b))) {
    scan.records.push({
      source: 'confluence:worklog',
      file: page.title,
      input: dayLogInput(
        date,
        text,
        timeZone,
        { page: { id: page.id, title: page.title, version: page.version } },
        page.url,
      ),
    });
  }
  return scan;
}
