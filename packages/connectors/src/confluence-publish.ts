import { addDays, sha256Hex } from '@xjournal/core';
import {
  type ConfluenceConfig,
  cellOf,
  findMonthPage,
  type MonthPage,
  monthTitle,
  storageToText,
} from './confluence-worklog';

// Publishing a daily report to the Confluence work log (plan.md M3), as the prototype's
// `publish-day` did: one row per day on the "<Month>, <YYYY>" page under "Work Logs - <YYYY>",
// under the work-log root page. It refuses to overwrite a row whose text changed since the
// hub last published it (someone edited it in Confluence), unless forced.

export interface WorklogTarget extends ConfluenceConfig {
  /** The page the "Work Logs - <YYYY>" pages live under. */
  rootPageId: string;
  /** Jira application link, so [PROJ-123] becomes a live Jira macro. */
  jira?: { server: string; serverId: string };
}

const ROW_RE = /<tr>(?:(?!<\/tr>)[\s\S])*?<\/tr>/g;
const TIME_RE = /<time datetime="(\d{4}-\d{2}-\d{2})"/;
export const TABLE_HEAD =
  '<p>Daily Logs</p><table class="relative-table wrapped" style="width: 100.153%;"><colgroup>' +
  '<col style="width: 27.4545%;" /><col style="width: 72.5187%;" /></colgroup><tbody>' +
  '<tr><th>Date</th><th>Logs</th></tr></tbody></table>';

const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function jiraMacro(key: string, jira: NonNullable<WorklogTarget['jira']>) {
  return (
    '<ac:structured-macro ac:name="jira" ac:schema-version="1">' +
    `<ac:parameter ac:name="server">${escapeHtml(jira.server)}</ac:parameter>` +
    `<ac:parameter ac:name="serverId">${escapeHtml(jira.serverId)}</ac:parameter>` +
    `<ac:parameter ac:name="key">${key}</ac:parameter></ac:structured-macro>`
  );
}

function inline(s: string, jira?: WorklogTarget['jira']): string {
  let out = escapeHtml(s);
  out = out.replace(
    /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g,
    (_m, t: string, u: string) => `<a href="${u}">${t}</a>`,
  );
  out = out.replace(/&lt;(https?:\/\/\S+?)&gt;/g, (_m, u: string) => `<a href="${u}">${u}</a>`);
  if (jira)
    out = out.replace(/\[([A-Z][A-Z0-9]+-\d+)\](?!\()/g, (_m, k: string) => jiraMacro(k, jira));
  out = out.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/`([^`]+)`/g, '<code>$1</code>');
  return out;
}

/** Report Markdown (citations already removed) → Confluence storage XHTML for a table cell. */
export function markdownToStorage(md: string, jira?: WorklogTarget['jira']): string {
  const out: string[] = [];
  const stack: number[] = [];
  const closeLists = () => {
    while (stack.length) {
      out.push('</li></ul>');
      stack.pop();
    }
  };
  for (const raw of md.replace(/\r\n?/g, '\n').split('\n')) {
    if (!raw.trim()) continue;
    const m = raw.replace(/\t/g, '  ').match(/^(\s*)(?:[-*+]|\d+[.)])\s+(.*)$/);
    if (m) {
      const ind = (m[1] ?? '').length;
      if (!stack.length || ind > (stack.at(-1) as number)) {
        out.push('<ul>');
        stack.push(ind);
      } else {
        while (stack.length && ind < (stack.at(-1) as number)) {
          out.push('</li></ul>');
          stack.pop();
        }
        out.push('</li>');
      }
      out.push(`<li>${inline(m[2] ?? '', jira)}`);
      continue;
    }
    closeLists();
    const h = raw.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      const n = (h[1] ?? '').length;
      // Inside a table cell, top-level headings render as bold paragraphs (as the logs do).
      out.push(
        n <= 2
          ? `<p><strong>${inline(h[2] ?? '', jira)}</strong></p>`
          : `<h${n}>${inline(h[2] ?? '', jira)}</h${n}>`,
      );
    } else {
      out.push(`<p>${inline(raw.trim(), jira)}</p>`);
    }
  }
  closeLists();
  return out.join('');
}

export const rowHtml = (date: string, content: string) =>
  `<tr><td><div class="content-wrapper"><p><time datetime="${date}" /> </p></div></td>` +
  `<td><div class="content-wrapper">${content}</div></td></tr>`;

/** The guard's fingerprint of a row's cell: its text, whitespace-normalized. */
export const cellHash = (cell: string) =>
  sha256Hex(storageToText(cell).replace(/\s+/g, ' ').trim()).slice(0, 16);

export function findRow(
  body: string,
  date: string,
): { start: number; end: number; html: string } | null {
  for (const m of body.matchAll(ROW_RE)) {
    if (TIME_RE.exec(m[0])?.[1] === date)
      return { start: m.index ?? 0, end: (m.index ?? 0) + m[0].length, html: m[0] };
  }
  return null;
}

/** Put the row for `date` into a month page body: replace it, or insert it in date order. */
export function placeRow(body: string, date: string, content: string): string {
  const row = rowHtml(date, content);
  const existing = findRow(body, date);
  if (existing) return body.slice(0, existing.start) + row + body.slice(existing.end);
  let b = body.includes('</tbody>') ? body : body + TABLE_HEAD;
  let pos = b.lastIndexOf('</tbody>');
  for (const m of b.matchAll(ROW_RE)) {
    const d = TIME_RE.exec(m[0])?.[1];
    if (d && d > date) {
      pos = m.index ?? pos;
      break;
    }
  }
  b = b.slice(0, pos) + row + b.slice(pos);
  return b;
}

// ------------------------------------------------------------------------------------------
// REST
// ------------------------------------------------------------------------------------------

const authOf = (cfg: ConfluenceConfig) =>
  cfg.user
    ? `Basic ${Buffer.from(`${cfg.user}:${cfg.token}`).toString('base64')}`
    : `Bearer ${cfg.token}`;

async function send<T>(
  cfg: ConfluenceConfig,
  method: 'POST' | 'PUT',
  path: string,
  body: unknown,
): Promise<T> {
  const base = cfg.baseUrl.replace(/\/+$/, '');
  const res = await (cfg.fetch ?? fetch)(`${base}${path}`, {
    method,
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      authorization: authOf(cfg),
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = (await res.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 200);
    throw new Error(`Confluence: ${method} ${path}: ${res.status} ${text}`);
  }
  return (await res.json()) as T;
}

async function createPage(
  cfg: WorklogTarget,
  title: string,
  parentId: string,
  body: string,
): Promise<MonthPage> {
  await send(cfg, 'POST', '/rest/api/content', {
    type: 'page',
    title,
    space: { key: cfg.spaceKey },
    ancestors: [{ id: parentId }],
    body: { storage: { value: body, representation: 'storage' } },
  });
  const p = await findMonthPage(cfg, title);
  if (!p) throw new Error(`Confluence: created "${title}" but can't read it back`);
  return p;
}

async function updatePage(cfg: WorklogTarget, page: MonthPage, body: string): Promise<void> {
  await send(cfg, 'PUT', `/rest/api/content/${page.id}`, {
    id: page.id,
    type: 'page',
    title: page.title,
    version: { number: page.version + 1, message: 'xjournal' },
    body: { storage: { value: body, representation: 'storage' } },
  });
}

export type PublishOutcome =
  | { status: 'published'; url: string; pageTitle: string; contentHash: string }
  | { status: 'refused'; url: string; pageTitle: string; currentText: string };

/**
 * Publish one day. `lastHash` is the cell fingerprint recorded the last time the hub published
 * this date (null: never). A non-empty row that doesn't match it was written or edited by
 * someone else, so it's refused unless `force`.
 */
export async function publishWorklogDay(
  cfg: WorklogTarget,
  o: { date: string; markdown: string; lastHash: string | null; force?: boolean },
): Promise<PublishOutcome> {
  const content = markdownToStorage(o.markdown, cfg.jira);
  // The row may sit on its month's page or, near a month boundary, the previous one.
  const prevMonth = addDays(`${o.date.slice(0, 7)}-01`, -1);
  let page: MonthPage | null = null;
  for (const title of [monthTitle(o.date), monthTitle(prevMonth)]) {
    const p = await findMonthPage(cfg, title);
    if (p && findRow(p.body, o.date)) {
      page = p;
      break;
    }
  }
  if (page) {
    const row = findRow(page.body, o.date);
    const cell = row ? cellOf(row.html) : '';
    const text = storageToText(cell);
    if (text && cellHash(cell) !== o.lastHash && !o.force) {
      return { status: 'refused', url: page.url, pageTitle: page.title, currentText: text };
    }
  } else {
    page = await findMonthPage(cfg, monthTitle(o.date));
    if (!page) {
      const yearTitle = `Work Logs - ${o.date.slice(0, 4)}`;
      const year =
        (await findMonthPage(cfg, yearTitle)) ??
        (await createPage(cfg, yearTitle, cfg.rootPageId, '<p>Monthly work logs.</p>'));
      page = await createPage(cfg, monthTitle(o.date), year.id, TABLE_HEAD);
    }
  }
  await updatePage(cfg, page, placeRow(page.body, o.date, content));
  // Fingerprint what Confluence stored, which may differ from what was sent.
  const after = await findMonthPage(cfg, page.title);
  const row = after ? findRow(after.body, o.date) : null;
  return {
    status: 'published',
    url: after?.url ?? page.url,
    pageTitle: page.title,
    contentHash: cellHash(row ? cellOf(row.html) : content),
  };
}
