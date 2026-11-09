import type { RecordInput } from '@xjournal/core';
import { z } from 'zod';
import {
  ConnectorAuthError,
  ConnectorRateLimitError,
  type Cursor,
  defineConnector,
  type SyncInput,
  type SyncPage,
} from './sdk';

// GitHub and GitHub Enterprise Server (spec §8.2): PRs opened and merged, reviews, comments,
// and commits pushed, one record each. Carries over the prototype's owner and noise filters
// (spec §8.5, Appendix A).
//
// Streams:
//   events          /users/{login}/events: everything, but only ~90 days and 300 events back.
//   search:opened   PRs authored, by creation date: older history, and a cross-check.
//   search:merged   PRs authored, by merge date: merges by others never show in my events.
// Opened and merged PRs get the same external IDs from events and search, so they dedupe.

export const zGithubConfig = z.object({
  /** 'github.com' or a GitHub Enterprise Server host. */
  host: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9.-]+(:\d+)?$/, 'a host name, e.g. github.com'),
  login: z.string().trim().min(1),
  /** Only repos owned by these users or orgs (empty: all). */
  includeOwners: z.array(z.string()).default([]),
  /** Never repos owned by these (e.g. your personal repos). */
  excludeOwners: z.array(z.string()).default([]),
  /** Pushes to these branches are merges landing, which the PRs already cover. */
  sharedBranches: z.array(z.string()).default(['main', 'master', 'develop', 'trunk']),
  /** Branch prefixes treated as shared too. */
  sharedBranchPrefixes: z.array(z.string()).default(['release']),
  /** Comments starting with one of these are bot commands (e.g. `/ci`). */
  commandPrefixes: z.array(z.string()).default(['/']),
});
export type GithubConfig = z.infer<typeof zGithubConfig>;

const EVENT_PAGES = 3; // the events API returns at most 300 events
const SEARCH_WINDOW_DAYS = 90; // search returns at most 1,000 results per query
const SEARCH_OVERLAP_DAYS = 7; // re-read the last week: late merges, edited titles
const SEARCH_MAX_PAGE = 10;
const COMMENT_CHARS = 240;

export const apiBase = (host: string) =>
  host === 'github.com' ? 'https://api.github.com' : `https://${host}/api/v3`;

// ------------------------------------------------------------------------------------------
// HTTP
// ------------------------------------------------------------------------------------------

type Json = Record<string, unknown>;

class Gh {
  constructor(private readonly input: SyncInput<GithubConfig>) {}

  async get<T = Json>(path: string, params: Record<string, string | number> = {}): Promise<T> {
    const url = new URL(apiBase(this.input.config.host) + path);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
    const headers: Record<string, string> = {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'xjournal',
    };
    if (this.input.secret) headers.Authorization = `Bearer ${this.input.secret}`;
    const res = await this.input.fetch(url, {
      headers,
      ...(this.input.signal ? { signal: this.input.signal } : {}),
    });
    if (res.ok) return (await res.json()) as T;

    const body = (await res.text().catch(() => '')).slice(0, 200);
    const where = `GET ${url.pathname}`;
    if (res.status === 401) throw new ConnectorAuthError(`${where}: 401 ${body}`);
    const remaining = res.headers.get('x-ratelimit-remaining');
    if (
      res.status === 429 ||
      (res.status === 403 && (remaining === '0' || /rate limit/i.test(body)))
    ) {
      const reset = Number(res.headers.get('x-ratelimit-reset'));
      throw new ConnectorRateLimitError(
        `${where}: rate limited`,
        reset ? new Date(reset * 1000) : undefined,
      );
    }
    throw new Error(`${where}: ${res.status} ${body}`);
  }
}

// ------------------------------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------------------------------

const lower = (s: string) => s.toLowerCase();
const firstLine = (s: string) => (s.split(/\r?\n/, 1)[0] ?? '').trim();
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const repoOfUrl = (repositoryUrl: string) => repositoryUrl.split('/').slice(-2).join('/');
const addDaysIso = (date: string, days: number) => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

export function ownerAllowed(config: GithubConfig, repo: string): boolean {
  const owner = lower(repo.split('/')[0] ?? '');
  const inc = config.includeOwners.map(lower);
  if (inc.length && !inc.includes(owner)) return false;
  return !config.excludeOwners.map(lower).includes(owner);
}

function isSharedBranch(config: GithubConfig, branch: string) {
  return (
    config.sharedBranches.includes(branch) ||
    config.sharedBranchPrefixes.some((p) => branch.startsWith(p))
  );
}

/** Merge commits and squash-merge copies of PRs that are recorded already. */
export const isNoiseCommit = (message: string) =>
  /^Merge (pull request|branch|remote-tracking branch) /.test(message) || /\(#\d+\)$/.test(message);

/** The owner's logins, names and emails, lower-cased. */
function mineMatcher(input: SyncInput<GithubConfig>) {
  const keys = new Set([lower(input.config.login)]);
  for (const i of input.identities) {
    keys.add(lower(i.accountKey));
    for (const a of i.aliases) keys.add(lower(a));
  }
  return (...bits: (string | null | undefined)[]) => bits.some((b) => b && keys.has(lower(b)));
}

interface PullInfo {
  title: string;
  author: string;
}

/** PR titles and authors, fetched once per sync when an event payload lacks them. */
function pullCache(gh: Gh) {
  const cache = new Map<string, Promise<PullInfo | null>>();
  return (repo: string, num: number) => {
    const key = `${repo}#${num}`;
    let p = cache.get(key);
    if (!p) {
      p = gh
        .get<{ title?: string; user?: { login?: string } }>(`/repos/${repo}/pulls/${num}`)
        .then((x) => ({ title: x.title ?? '', author: x.user?.login ?? '' }))
        .catch((e: unknown) => {
          if (e instanceof ConnectorAuthError || e instanceof ConnectorRateLimitError) throw e;
          return null;
        });
      cache.set(key, p);
    }
    return p;
  };
}

// Records. Opened and merged PRs use the same shape from events and search, so they dedupe
// to "unchanged" rather than adding revisions.

const web = (config: GithubConfig) => `https://${config.host}`;

function prRecord(
  config: GithubConfig,
  a: {
    repo: string;
    num: number;
    title: string;
    action: 'opened' | 'merged';
    at: string;
    actor: string;
  },
): RecordInput {
  const verb = a.action === 'opened' ? 'Opened' : 'Merged';
  return {
    externalId: `${a.repo}#${a.num}/${a.action}`,
    kind: 'pull_request',
    eventTime: a.at,
    title: clip(`${verb} PR #${a.num}: ${a.title || '(untitled)'}`, 300),
    url: `${web(config)}/${a.repo}/pull/${a.num}`,
    actor: a.actor,
    payload: { repo: a.repo, number: a.num, action: a.action },
  };
}

// ------------------------------------------------------------------------------------------
// events
// ------------------------------------------------------------------------------------------

interface GhEvent {
  id: string;
  type: string;
  created_at: string;
  actor?: { login?: string };
  repo: { name: string };
  payload: Json;
}

// The feed is neither ID- nor strictly time-ordered (each event type has its own ID range),
// so it's read whole (at most 300 events) and filtered by time; records dedupe the overlap.
const RESYNC_SLACK_MS = 60 * 60 * 1000;
const HISTORY_DAYS = 90;

async function syncEvents(input: SyncInput<GithubConfig>): Promise<SyncPage> {
  const { config } = input;
  const gh = new Gh(input);
  const pull = pullCache(gh);
  const isMine = mineMatcher(input);
  const prior = input.cursor as { since?: string } | null;
  // From an hour before the newest event seen last time; without one, from the start of the
  // backfill day with a day of slack for time zones.
  const from = prior?.since
    ? new Date(Date.parse(prior.since) - RESYNC_SLACK_MS)
    : new Date(`${addDaysIso(input.backfillFrom, -1)}T00:00:00Z`);

  const all: GhEvent[] = [];
  let exhausted = false;
  for (let page = 1; page <= EVENT_PAGES; page++) {
    const batch = await gh.get<GhEvent[]>(`/users/${encodeURIComponent(config.login)}/events`, {
      per_page: 100,
      page,
    });
    all.push(...batch);
    if (batch.length < 100) {
      exhausted = true;
      break;
    }
  }
  const time = (e: GhEvent) => Date.parse(e.created_at);
  const events = all.filter((e) => time(e) >= from.getTime());

  const records: RecordInput[] = [];
  for (const ev of events) {
    const repo = ev.repo.name;
    if (!ownerAllowed(config, repo)) continue;
    const p = ev.payload;
    const actor = ev.actor?.login ?? config.login;

    switch (ev.type) {
      case 'PullRequestEvent': {
        const pr = (p.pull_request ?? {}) as Json;
        const num = Number(p.number ?? pr.number);
        // Newer payloads say 'merged'; older ones 'closed' with `merged: true`.
        const merged = p.action === 'merged' || (p.action === 'closed' && pr.merged === true);
        const action = merged ? 'merged' : p.action;
        if (action !== 'opened' && action !== 'merged') break;
        const title = (pr.title as string) || (await pull(repo, num))?.title || '';
        const at = (merged ? (pr.merged_at as string) : (pr.created_at as string)) || ev.created_at;
        records.push(prRecord(config, { repo, num, title, action, at, actor }));
        break;
      }
      case 'PullRequestReviewEvent': {
        const pr = (p.pull_request ?? {}) as Json;
        const review = (p.review ?? {}) as Json;
        const num = Number(pr.number);
        const info = (pr.title && (pr.user as Json)?.login ? null : await pull(repo, num)) ?? null;
        const author = ((pr.user as Json)?.login as string) || info?.author || '';
        // Replying to review threads on my own PR shows up as a "review"; it isn't one.
        if (isMine(author)) break;
        const title = (pr.title as string) || info?.title || '';
        const state = lower(String(review.state ?? 'reviewed')).replace(/_/g, ' ');
        records.push({
          externalId: `${repo}#${num}/review/${review.id ?? ev.id}`,
          kind: 'review',
          eventTime: (review.submitted_at as string) || ev.created_at,
          title: clip(`Reviewed PR #${num} (${state}): ${title || '(untitled)'}`, 300),
          url: (review.html_url as string) || `${web(config)}/${repo}/pull/${num}`,
          actor,
          payload: { repo, number: num, state },
        });
        break;
      }
      case 'IssueCommentEvent':
      case 'PullRequestReviewCommentEvent':
      case 'CommitCommentEvent': {
        const comment = (p.comment ?? {}) as Json;
        const body = String(comment.body ?? '')
          .replace(/\r/g, '')
          .trim();
        if (config.commandPrefixes.some((c) => body.startsWith(c))) break;
        const target = (p.issue ?? p.pull_request ?? {}) as Json;
        const num = target.number != null ? Number(target.number) : null;
        const isPr = ev.type !== 'IssueCommentEvent' || target.pull_request != null;
        const title =
          (target.title as string) ||
          (num != null && isPr ? (await pull(repo, num))?.title : '') ||
          '';
        const what = num != null ? `#${num}${title ? ` ${title}` : ''}` : repo;
        records.push({
          externalId: `${repo}/comment/${comment.id ?? ev.id}`,
          kind: ev.type === 'IssueCommentEvent' ? 'issue_comment' : 'code_comment',
          eventTime: (comment.created_at as string) || ev.created_at,
          title: clip(`Commented on ${what}`, 300),
          url: (comment.html_url as string) || `${web(config)}/${repo}`,
          actor,
          summary: clip(body, COMMENT_CHARS),
          payload: { repo, ...(num != null ? { number: num } : {}) },
        });
        break;
      }
      case 'PushEvent': {
        const branch = String(p.ref ?? '').replace(/^refs\/heads\//, '');
        if (isSharedBranch(config, branch)) break;
        for (const c of await pushedCommits(gh, repo, p)) {
          if (!isMine(c.login, c.name, c.email)) continue;
          const message = firstLine(c.message);
          if (!message || isNoiseCommit(message)) continue;
          records.push({
            externalId: `${repo}@${c.sha}`,
            kind: 'commit',
            // The day it was pushed, as the prototype counted it: rebases and cherry-picks
            // keep old author dates.
            eventTime: ev.created_at,
            title: clip(message, 300),
            url: `${web(config)}/${repo}/commit/${c.sha}`,
            actor: c.login || c.email || c.name || actor,
            payload: { repo, sha: c.sha },
          });
        }
        break;
      }
    }
  }

  // Dedupe within the page (a commit pushed to two branches, a PR in two events).
  const byId = new Map(records.map((r) => [r.externalId, r]));
  const times = all.map(time);
  const newest = times.length ? new Date(Math.max(...times)).toISOString() : prior?.since;
  const oldest = times.length ? Math.min(...times) : null;
  // The feed doesn't reach back to `from`: it was cut at 300 events, or `from` is past the
  // ~90 days GitHub keeps.
  const cut = !exhausted || from.getTime() < input.now.getTime() - HISTORY_DAYS * 86_400_000;
  const truncated = oldest != null && oldest > from.getTime() && cut ? new Date(oldest) : undefined;
  return {
    records: [...byId.values()],
    cursor: newest ? { since: newest } : (input.cursor ?? null),
    more: false,
    ...(truncated ? { historyFloor: truncated } : {}),
  };
}

interface PushedCommit {
  sha: string;
  message: string;
  name?: string;
  email?: string;
  login?: string;
  date?: string;
}

/** A push's commits: from the payload when GitHub includes them, otherwise by comparing. */
async function pushedCommits(gh: Gh, repo: string, p: Json): Promise<PushedCommit[]> {
  if (Array.isArray(p.commits) && p.commits.length) {
    return (p.commits as Json[]).map((c) => {
      const a = (c.author ?? {}) as Json;
      return {
        sha: String(c.sha),
        message: String(c.message ?? ''),
        name: a.name as string,
        email: a.email as string,
      };
    });
  }
  const head = p.head as string | undefined;
  if (!head) return [];
  const before = (p.before as string | undefined) ?? '';
  type ApiCommit = {
    sha: string;
    author?: { login?: string } | null;
    commit: { message: string; author?: { name?: string; email?: string; date?: string } };
  };
  try {
    const list: ApiCommit[] =
      before && !/^0+$/.test(before)
        ? ((await gh.get<{ commits?: ApiCommit[] }>(`/repos/${repo}/compare/${before}...${head}`))
            .commits ?? [])
        : [await gh.get<ApiCommit>(`/repos/${repo}/commits/${head}`)];
    return list.map((c) => ({
      sha: c.sha,
      message: c.commit.message,
      ...(c.commit.author?.name ? { name: c.commit.author.name } : {}),
      ...(c.commit.author?.email ? { email: c.commit.author.email } : {}),
      ...(c.commit.author?.date ? { date: c.commit.author.date } : {}),
      ...(c.author?.login ? { login: c.author.login } : {}),
    }));
  } catch (e) {
    // Force-pushed away or no access: skip the push, not the sync.
    if (e instanceof ConnectorAuthError || e instanceof ConnectorRateLimitError) throw e;
    return [];
  }
}

// ------------------------------------------------------------------------------------------
// search:opened, search:merged
// ------------------------------------------------------------------------------------------

interface SearchCursor {
  /** Start of the current window (YYYY-MM-DD). */
  from: string;
  page: number;
}

interface SearchItem {
  number: number;
  title: string;
  repository_url: string;
  created_at: string;
  closed_at: string | null;
  user?: { login?: string };
  pull_request?: { merged_at?: string | null };
}

async function syncSearch(
  input: SyncInput<GithubConfig>,
  action: 'opened' | 'merged',
): Promise<SyncPage> {
  const { config } = input;
  const gh = new Gh(input);
  const today = input.now.toISOString().slice(0, 10);
  const c = (input.cursor as SearchCursor | null) ?? { from: input.backfillFrom, page: 1 };
  const windowEnd = [addDaysIso(c.from, SEARCH_WINDOW_DAYS - 1), today].sort()[0] as string;
  const qualifier = action === 'opened' ? 'created' : 'merged';
  const q = `is:pr author:${config.login} ${qualifier}:${c.from}..${windowEnd}`;
  const res = await gh.get<{ items?: SearchItem[] }>('/search/issues', {
    q,
    sort: 'created',
    order: 'asc',
    per_page: 100,
    page: c.page,
  });
  const items = res.items ?? [];

  const records: RecordInput[] = [];
  for (const it of items) {
    const repo = repoOfUrl(it.repository_url);
    if (!ownerAllowed(config, repo)) continue;
    const at = action === 'opened' ? it.created_at : (it.pull_request?.merged_at ?? it.closed_at);
    if (!at) continue;
    records.push(
      prRecord(config, {
        repo,
        num: it.number,
        title: it.title,
        action,
        at,
        actor: it.user?.login ?? config.login,
      }),
    );
  }

  let cursor: SearchCursor;
  let more: boolean;
  if (items.length === 100 && c.page < SEARCH_MAX_PAGE) {
    cursor = { from: c.from, page: c.page + 1 };
    more = true;
  } else if (windowEnd < today) {
    cursor = { from: addDaysIso(windowEnd, 1), page: 1 };
    more = true;
  } else {
    // Caught up: next time, re-read the last week.
    cursor = {
      from: [addDaysIso(today, -SEARCH_OVERLAP_DAYS), c.from].sort().at(-1) as string,
      page: 1,
    };
    more = false;
  }
  return { records, cursor: cursor as unknown as Cursor, more };
}

// ------------------------------------------------------------------------------------------

export const github = defineConnector<GithubConfig>({
  describe: () => ({
    kind: 'github',
    displayName: 'GitHub',
    authTypes: ['pat', 'oauth', 'app'],
    streams: [
      { key: 'events', description: 'PRs, reviews, comments and commits from your event feed' },
      { key: 'search:opened', description: 'PRs you opened, by date (reaches past 90 days)' },
      { key: 'search:merged', description: 'Your PRs merged, by anyone' },
    ],
    policy: { fullText: false, historyLimitDays: 90 },
  }),
  parseConfig: (raw) => zGithubConfig.parse(raw),
  sourceKey: (config) => `github:${config.host}`,
  configSchema: () => z.toJSONSchema(zGithubConfig, { io: 'input' }) as Record<string, unknown>,
  defaultIdentity: (config) => ({ accountKey: config.login, aliases: [] }),
  sync(input) {
    switch (input.stream) {
      case 'events':
        return syncEvents(input);
      case 'search:opened':
        return syncSearch(input, 'opened');
      case 'search:merged':
        return syncSearch(input, 'merged');
      default:
        throw new Error(`github: unknown stream ${input.stream}`);
    }
  },
});
