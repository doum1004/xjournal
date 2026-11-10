import type { RecordView, WorkItemGroup, WorkItemSummary } from '@xjournal/core';
import {
  bundleRepo,
  type HubDb,
  type PlannedItem,
  type Tx,
  withSystem,
  workItemRepo,
} from '@xjournal/db';

// Work items (spec §3.5, docs/adr/0008): the records of one piece of work, grouped so reports
// describe it once. This is the deterministic half: links follow from what records say about
// themselves, never from guesses.
//
// Anchors:
//   - a Jira issue, 'PIX-123': Jira's own records of it (payload.issue);
//   - a pull request, 'owner/repo#12': GitHub's records of it (payload.repo + number).
// References in text (titles, summaries) link a record to an anchor:
//   - a Jira key, or a Jira /browse/ link;
//   - a pull request link.
// A pull request whose own records mention a Jira key folds into that issue's item, and so do
// the records that reference the pull request. Each remaining anchor with two or more records
// is a work item. A record may be in more than one item.

export interface LinkInput {
  id: string;
  source: string;
  kind: string;
  noteKind?: string | null;
  title: string;
  summary?: string | null;
  url?: string | null;
  visibility: string;
  eventTime: Date;
  payload: unknown;
}

/** Look like Jira keys but aren't: encodings, hashes, standards. */
const NOT_JIRA = new Set([
  'AES',
  'CVE',
  'COVID',
  'ECMA',
  'ES',
  'GPT',
  'HTTP',
  'IPV',
  'ISO',
  'MD',
  'RFC',
  'RSA',
  'SHA',
  'SSL',
  'TLS',
  'UTF',
  'WIN',
]);
const JIRA_KEY = /(?<![A-Za-z0-9-])([A-Z][A-Z0-9]{1,9})-([1-9]\d{0,6})(?![A-Za-z0-9-])/g;
const IS_JIRA_KEY = /^[A-Z][A-Z0-9]{1,9}-[1-9]\d{0,6}$/;
const JIRA_BROWSE = /\/browse\/([A-Z][A-Z0-9]{1,9}-[1-9]\d{0,6})\b/g;
const PR_URL = /https?:\/\/[^\s/<>()]+\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/g;

/** Records that summarize many pieces of work, which text links would wrongly join. */
const SKIP_KINDS = new Set(['imported_log']);
const SKIP_NOTE_KINDS = new Set(['context', 'guidance']);
/** A record that mentions more anchors than this is a roundup: no text links from it. */
export const MAX_TEXT_ANCHORS = 3;

const obj = (p: unknown): Record<string, unknown> =>
  p && typeof p === 'object' ? (p as Record<string, unknown>) : {};

/** The anchor a record belongs to by itself, if any. */
export function ownAnchor(r: LinkInput): string | null {
  const p = obj(r.payload);
  if (typeof p.issue === 'string' && r.kind.startsWith('issue_') && IS_JIRA_KEY.test(p.issue)) {
    return p.issue;
  }
  if (
    typeof p.repo === 'string' &&
    typeof p.number === 'number' &&
    ['pull_request', 'review', 'code_comment', 'issue_comment'].includes(r.kind)
  ) {
    return `${p.repo}#${p.number}`;
  }
  return null;
}

/** Jira keys and pull requests a piece of text refers to, in order of appearance. */
export function textAnchors(text: string, knownPrefixes?: Set<string>): string[] {
  const found = new Map<number, string>();
  for (const m of text.matchAll(JIRA_KEY)) {
    const prefix = m[1] as string;
    if (NOT_JIRA.has(prefix) && !knownPrefixes?.has(prefix)) continue;
    found.set(m.index ?? 0, `${prefix}-${m[2]}`);
  }
  for (const m of text.matchAll(JIRA_BROWSE)) found.set(m.index ?? 0, m[1] as string);
  for (const m of text.matchAll(PR_URL)) found.set(m.index ?? 0, `${m[1]}#${m[2]}`);
  return [...new Set([...found.entries()].sort(([a], [b]) => a - b).map(([, v]) => v))];
}

const isJiraKey = (anchor: string) => !anchor.includes('#');

/** "Merged PR #12: Fix the thing" → "Fix the thing". */
const prTitle = (title: string) => title.replace(/^.*?\bPR #\d+(?: \([^)]*\))?: /, '').trim();
/** "Created PIX-1 Fix it" / "Commented on PIX-1 Fix it" → "PIX-1 Fix it". */
const issueTitle = (title: string) => title.replace(/^(Created|Commented on) /, '').trim();

/**
 * An issue's title from a PR title that names it: "feat(PIX-1): Add it", "fix #PIX-1: Add it"
 * and "chore(x): Add it (PIX-1)" all become "PIX-1 Add it".
 */
export function describeIssue(key: string, title: string): string {
  let t = title;
  const m = t.match(/^([^:]{1,40}):\s+(.+)$/);
  if (m && ((m[1] as string).includes(key) || /^[a-z]+(\([^)]*\))?!?$/i.test(m[1] as string))) {
    t = m[2] as string;
  }
  t = t.replace(new RegExp(`\\s*[([]?#?${key}[)\\]]?[:,]?(\\s+|$)`), ' ').trim();
  return t ? `${key} ${t}` : key;
}

function titleFor(anchor: string, rs: LinkInput[]): string {
  // Readers of an item may see only its project-visible records (see 0011_work_items_rls.sql).
  const shared = rs.filter((r) => r.visibility === 'project');
  const pool = shared.length ? shared : rs;
  if (isJiraKey(anchor)) {
    const change = pool.find((r) => obj(r.payload).issue === anchor && r.summary);
    if (change?.summary) return `${anchor} ${change.summary}`;
    const own = pool.find(
      (r) => obj(r.payload).issue === anchor && /^(Created|Commented on) /.test(r.title),
    );
    if (own) return issueTitle(own.title);
    const pr = pool.find((r) => r.kind === 'pull_request' && r.title.includes(anchor));
    if (pr) return describeIssue(anchor, prTitle(pr.title));
    return anchor;
  }
  const pr = pool.find((r) => ownAnchor(r) === anchor && /\bPR #\d+/.test(r.title));
  const name = pr ? prTitle(pr.title) : '';
  return name && name !== '(untitled)' ? `${anchor} ${name}` : anchor;
}

function urlFor(anchor: string, rs: LinkInput[]): string | null {
  for (const r of rs) {
    if (!r.url || ownAnchor(r) !== anchor) continue;
    if (isJiraKey(anchor)) {
      const m = r.url.match(/^(.*\/browse\/[A-Z][A-Z0-9]*-\d+)/);
      if (m) return m[1] as string;
    } else {
      const m = r.url.match(/^(.*\/pull\/\d+)/);
      if (m) return m[1] as string;
    }
  }
  return null;
}

function addTo(m: Map<string, Set<string>>, key: string, value: string) {
  const set = m.get(key);
  if (set) set.add(value);
  else m.set(key, new Set([value]));
}

/** Plan a project's work items from its records. Pure, so it can be tested on its own. */
export function planWorkItems(inputs: LinkInput[]): PlannedItem[] {
  const rs = inputs.filter(
    (r) => !SKIP_KINDS.has(r.kind) && !(r.noteKind && SKIP_NOTE_KINDS.has(r.noteKind)),
  );
  const knownPrefixes = new Set<string>();
  for (const r of rs) {
    const a = ownAnchor(r);
    if (a && isJiraKey(a)) knownPrefixes.add(a.split('-')[0] as string);
  }

  // anchor → records, own and by reference; record → its own anchor.
  const members = new Map<string, Set<string>>();
  const add = (anchor: string, id: string) => addTo(members, anchor, id);
  // pull request → the Jira keys its own records mention
  const prIssues = new Map<string, Set<string>>();
  for (const r of rs) {
    const own = ownAnchor(r);
    if (own) add(own, r.id);
    // A Jira record mentioning another issue ("duplicates PIX-9") is not that issue's work.
    if (own && isJiraKey(own)) continue;
    const refs = textAnchors(`${r.title}\n${r.summary ?? ''}`, knownPrefixes).filter(
      (a) => a !== own,
    );
    if (refs.length > MAX_TEXT_ANCHORS) continue;
    for (const a of refs) {
      add(a, r.id);
      if (own && !isJiraKey(own) && isJiraKey(a)) {
        addTo(prIssues, own, a);
      }
    }
  }

  // Fold each pull request that names an issue into that issue's item.
  for (const [pr, issues] of prIssues) {
    const prMembers = members.get(pr);
    if (!prMembers) continue;
    for (const key of issues) for (const id of prMembers) add(key, id);
    members.delete(pr);
  }

  const byId = new Map(rs.map((r) => [r.id, r]));
  const out: PlannedItem[] = [];
  for (const [anchor, ids] of members) {
    if (ids.size < 2) continue;
    const records = [...ids]
      .map((id) => byId.get(id) as LinkInput)
      .sort((a, b) => a.eventTime.getTime() - b.eventTime.getTime() || a.id.localeCompare(b.id));
    out.push({
      key: anchor,
      title: titleFor(anchor, records).slice(0, 300),
      url: urlFor(anchor, records),
      recordIds: records.map((r) => r.id),
    });
  }
  return out.sort((a, b) => a.key.localeCompare(b.key));
}

export interface RelinkSummary {
  projects: number;
  items: number;
  created: number;
  linksAdded: number;
  linksRemoved: number;
}

/**
 * Rebuild the rule links of every project (or the ones given), system-side. Work items are
 * derived (spec §3.5): this never changes a record, and it's safe to run at any time.
 */
export async function relinkWorkItems(
  db: HubDb,
  opts: { projectIds?: string[]; now?: Date } = {},
): Promise<RelinkSummary> {
  const now = opts.now ?? new Date();
  const all = await withSystem(db, (tx) => bundleRepo.allProjects(tx));
  const projects = opts.projectIds ? all.filter((p) => opts.projectIds?.includes(p.id)) : all;
  const summary: RelinkSummary = {
    projects: projects.length,
    items: 0,
    created: 0,
    linksAdded: 0,
    linksRemoved: 0,
  };
  for (const p of projects) {
    const r = await withSystem(db, async (tx) =>
      workItemRepo.saveRuleLinks(
        tx,
        p,
        planWorkItems(await workItemRepo.linkInputs(tx, p.id)),
        now,
      ),
    );
    summary.items += r.items;
    summary.created += r.created;
    summary.linksAdded += r.linksAdded;
    summary.linksRemoved += r.linksRemoved;
  }
  return summary;
}

// ------------------------------------------------------------------------------------------
// Views
// ------------------------------------------------------------------------------------------

/**
 * Group record views (from `toViews`, which fills `workItemIds`) by work item, under the
 * caller's RLS. Items come in the order of their first record; a record in several items
 * appears in each.
 */
export async function groupByWorkItem(
  tx: Tx,
  views: RecordView[],
): Promise<{ workItems: WorkItemGroup[]; unlinked: RecordView[] }> {
  const ids = [...new Set(views.flatMap((v) => v.workItemIds))];
  const rows = new Map((await workItemRepo.itemsByIds(tx, ids)).map((w) => [w.id, w]));
  const groups = new Map<string, WorkItemGroup>();
  const unlinked: RecordView[] = [];
  const byTime = [...views].sort(
    (a, b) => a.eventTime.localeCompare(b.eventTime) || a.id.localeCompare(b.id),
  );
  for (const v of byTime) {
    const mine = v.workItemIds.filter((id) => rows.has(id));
    if (!mine.length) unlinked.push(v);
    for (const id of mine) {
      const w = rows.get(id);
      if (!w) continue;
      let g = groups.get(id);
      if (!g) {
        g = { id, key: w.key, title: w.title, url: w.url, records: [] };
        groups.set(id, g);
      }
      g.records.push(v);
    }
  }
  // Keep the caller's order for unlinked records.
  const order = new Map(views.map((v, i) => [v.id, i]));
  unlinked.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
  return { workItems: [...groups.values()], unlinked };
}

/** Work items with records among `views`, summarized for weekly and longer reports. */
export function summarize(groups: WorkItemGroup[]): WorkItemSummary[] {
  return groups.map((g) => {
    const kinds: Record<string, number> = {};
    for (const r of g.records) kinds[r.kind] = (kinds[r.kind] ?? 0) + 1;
    return {
      id: g.id,
      key: g.key,
      title: g.title,
      url: g.url,
      days: [...new Set(g.records.map((r) => r.applicableDate))].sort(),
      kinds,
    };
  });
}
