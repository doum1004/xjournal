import type { RecordInput } from '@xjournal/core';
import { z } from 'zod';
import {
  AtlassianHttp,
  clip,
  dayBefore,
  hostOf,
  isoOf,
  oneLine,
  zAtlassianBase,
} from './atlassian';
import { type Cursor, defineConnector, type SyncInput, type SyncPage } from './sdk';

// Jira Server/Data Center (spec §8.2): issues created, changes and comments by you; plus
// issues created, status changes and comments by others in the projects you watch. Carries
// over the prototype's scope and noise filters (spec Appendix A).
//
// One stream, `issues`: JQL over issues updated since the cursor, oldest first, with their
// changelog. Each history entry, comment and creation is its own record, so re-reading an
// issue only adds what's new.

export const zJiraConfig = zAtlassianBase.extend({
  /** Projects whose other people's activity also counts (status changes, new issues, comments). */
  watchProjects: z.array(z.string().trim().toUpperCase()).default([]),
  /** Which issues are yours to follow. */
  scopeJql: z
    .string()
    .default('assignee = currentUser() OR reporter = currentUser() OR watcher = currentUser()'),
  /** Changelog fields that carry no information. */
  ignoreFields: z
    .array(z.string())
    .default([
      'Rank',
      'Sprint',
      'RemoteIssueLink',
      'timeestimate',
      'timespent',
      'WorklogId',
      'Workflow',
    ]),
});
export type JiraConfig = z.infer<typeof zJiraConfig>;

const PAGE = 50;
const COMMENT_CHARS = 240;
const FIELDS = ['summary', 'status', 'issuetype', 'reporter', 'created', 'comment', 'project'];

interface JiraUser {
  name?: string;
  key?: string;
  displayName?: string;
}
interface JiraIssue {
  key: string;
  fields: {
    summary: string;
    created: string;
    status?: { name?: string };
    issuetype?: { name?: string };
    reporter?: JiraUser | null;
    project?: { key?: string };
    comment?: { comments?: { id: string; body?: string; created: string; author?: JiraUser }[] };
  };
  changelog?: {
    histories?: {
      id: string;
      created: string;
      author?: JiraUser;
      items: { field: string; fromString?: string | null; toString?: string | null }[];
    }[];
  };
}

interface IssuesCursor {
  /** Issues updated on or after this day (YYYY-MM-DD, the Jira profile's time zone). */
  since: string;
  startAt: number;
}

export function jqlFor(config: JiraConfig, since: string): string {
  const scopes = [config.scopeJql.trim() ? `(${config.scopeJql})` : ''];
  if (config.watchProjects.length) scopes.push(`project in (${config.watchProjects.join(', ')})`);
  const scope = scopes.filter(Boolean).join(' OR ');
  return `(${scope}) AND updated >= "${since}" ORDER BY updated ASC`;
}

export function issueRecords(config: JiraConfig, issue: JiraIssue): RecordInput[] {
  const me = config.login.toLowerCase();
  const isMe = (u?: JiraUser | null) =>
    !!u && [u.name, u.key].some((x) => x && x.toLowerCase() === me);
  const f = issue.fields;
  const watched = config.watchProjects.includes((f.project?.key ?? '').toUpperCase());
  const url = `${config.baseUrl}/browse/${issue.key}`;
  const head = `${issue.key} ${f.summary}`;
  const base = { project: f.project?.key, issue: issue.key, type: f.issuetype?.name };
  const out: RecordInput[] = [];

  if (isMe(f.reporter) || watched) {
    out.push({
      externalId: `${issue.key}/created`,
      kind: 'issue_created',
      eventTime: isoOf(f.created),
      title: clip(`Created ${head}`, 300),
      url,
      actor: f.reporter?.name ?? 'unknown',
      payload: base,
    });
  }

  for (const h of issue.changelog?.histories ?? []) {
    const items = h.items.filter((i) => !config.ignoreFields.includes(i.field));
    const mine = isMe(h.author);
    // Others: only status changes, and only in watched projects.
    const kept = mine ? items : watched ? items.filter((i) => i.field === 'status') : [];
    if (!kept.length) continue;
    const what = kept
      .map((i) =>
        i.field === 'description'
          ? 'edited the description'
          : `${i.field}: ${i.fromString || '∅'} → ${i.toString || '∅'}`,
      )
      .join('; ');
    out.push({
      externalId: `${issue.key}/change/${h.id}`,
      kind: 'issue_change',
      eventTime: isoOf(h.created),
      title: clip(`${issue.key}: ${oneLine(what)}`, 300),
      url,
      actor: h.author?.name ?? 'unknown',
      summary: clip(f.summary, 300),
      payload: { ...base, fields: kept.map((i) => i.field) },
    });
  }

  for (const c of f.comment?.comments ?? []) {
    if (!isMe(c.author) && !watched) continue;
    out.push({
      externalId: `${issue.key}/comment/${c.id}`,
      kind: 'issue_comment',
      eventTime: isoOf(c.created),
      title: clip(`Commented on ${head}`, 300),
      url: `${url}?focusedCommentId=${c.id}`,
      actor: c.author?.name ?? 'unknown',
      summary: clip(oneLine(c.body ?? ''), COMMENT_CHARS),
      payload: base,
    });
  }
  return out;
}

async function syncIssues(input: SyncInput<JiraConfig>): Promise<SyncPage> {
  const http = new AtlassianHttp(input);
  const c = (input.cursor as IssuesCursor | null) ?? { since: input.backfillFrom, startAt: 0 };
  const res = await http.request<{ issues?: JiraIssue[]; total?: number }>(
    'POST',
    '/rest/api/2/search',
    {
      jql: jqlFor(input.config, c.since),
      startAt: c.startAt,
      maxResults: PAGE,
      fields: FIELDS,
      expand: ['changelog'],
    },
  );
  const issues = res.issues ?? [];
  const records = issues.flatMap((i) => issueRecords(input.config, i));
  const next = c.startAt + issues.length;
  if (issues.length === PAGE && next < (res.total ?? 0)) {
    return { records, cursor: { since: c.since, startAt: next } as unknown as Cursor, more: true };
  }
  // Caught up. Next time, from yesterday: JQL dates are in the profile's zone, so overlap a day.
  const today = input.now.toISOString().slice(0, 10);
  const since = [dayBefore(today), c.since].sort().at(-1) as string;
  return { records, cursor: { since, startAt: 0 } as unknown as Cursor, more: false };
}

export const jira = defineConnector<JiraConfig>({
  describe: () => ({
    kind: 'jira',
    displayName: 'Jira (Server/DC)',
    authTypes: ['pat'],
    streams: [
      { key: 'issues', description: 'Issues created, changed and commented on, with changelogs' },
    ],
    policy: { fullText: false },
  }),
  parseConfig: (raw) => zJiraConfig.parse(raw),
  sourceKey: (config) => `jira:${hostOf(config.baseUrl)}`,
  configSchema: () => z.toJSONSchema(zJiraConfig, { io: 'input' }) as Record<string, unknown>,
  defaultIdentity: (config) => ({ accountKey: config.login, aliases: [] }),
  sync(input) {
    if (input.stream !== 'issues') throw new Error(`jira: unknown stream ${input.stream}`);
    return syncIssues(input);
  },
});
