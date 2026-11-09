import { describe, expect, test } from 'bun:test';
import {
  apiBase,
  ConnectorAuthError,
  ConnectorRateLimitError,
  type Cursor,
  type GithubConfig,
  github,
  isNoiseCommit,
  ownerAllowed,
  type SyncInput,
} from '../src';

// A fake GitHub API: routes match on method-less path + selected query params.
type Route = (url: URL) => unknown | Response;
function fakeFetch(routes: Record<string, Route>) {
  const seen: string[] = [];
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    seen.push(`${url.pathname}${url.search}`);
    const auth = new Headers(init?.headers).get('authorization');
    if (auth !== 'Bearer tok') return new Response('Bad credentials', { status: 401 });
    const route = routes[url.pathname];
    if (!route) return new Response('Not Found', { status: 404 });
    const out = route(url);
    return out instanceof Response ? out : Response.json(out);
  }) as typeof fetch;
  return Object.assign(fn, { seen });
}

const config = (over: Partial<GithubConfig> = {}): GithubConfig =>
  github.parseConfig({ host: 'github.com', login: 'octocat', excludeOwners: ['octocat'], ...over });

function input(
  f: typeof fetch,
  over: Partial<SyncInput<GithubConfig>> = {},
): SyncInput<GithubConfig> {
  return {
    config: config(),
    secret: 'tok',
    stream: 'events',
    cursor: null,
    identities: [{ accountKey: 'octocat', aliases: ['Octo Cat', 'octo@example.test'] }],
    backfillFrom: '2026-11-01',
    now: new Date('2026-11-08T12:00:00Z'),
    fetch: f,
    log: { info() {}, warn() {} },
    ...over,
  };
}

let nextId = 9000; // counts down: the API lists newest first, with the highest IDs
const ev = (type: string, repo: string, payload: object, at = '2026-11-05T15:00:00Z') => ({
  id: String(nextId--),
  type,
  created_at: at,
  actor: { login: 'octocat' },
  repo: { name: repo },
  payload,
});

describe('github config and filters', () => {
  test('hosts, source keys and the API base', () => {
    expect(github.sourceKey(config())).toBe('github:github.com');
    expect(apiBase('github.com')).toBe('https://api.github.com');
    expect(apiBase('ghe.example.test')).toBe('https://ghe.example.test/api/v3');
    expect(() => github.parseConfig({ host: 'https://x', login: 'a' })).toThrow();
    expect(github.defaultIdentity?.(config())).toEqual({ accountKey: 'octocat', aliases: [] });
  });

  test('owner include and exclude lists, case-insensitively', () => {
    const c = config({ includeOwners: ['Acme'], excludeOwners: [] });
    expect(ownerAllowed(c, 'acme/sdk')).toBe(true);
    expect(ownerAllowed(c, 'other/sdk')).toBe(false);
    expect(ownerAllowed(config(), 'OctoCat/dotfiles')).toBe(false);
    expect(ownerAllowed(config(), 'acme/sdk')).toBe(true);
  });

  test('noise commits', () => {
    expect(isNoiseCommit('Merge pull request #4 from acme/x')).toBe(true);
    expect(isNoiseCommit("Merge branch 'main' into feature")).toBe(true);
    expect(isNoiseCommit('Fix the parser (#123)')).toBe(true);
    expect(isNoiseCommit('Merge sort for the importer')).toBe(false);
    expect(isNoiseCommit('Fix the parser')).toBe(false);
  });
});

describe('github events stream', () => {
  const events = [
    // Newest first, as the API returns them.
    ev('PushEvent', 'acme/sdk', { ref: 'refs/heads/main', head: 'aaa', before: 'bbb' }),
    ev('PushEvent', 'acme/sdk', {
      ref: 'refs/heads/feature/x',
      commits: [
        {
          sha: 's1',
          message: 'Add the parser\n\nbody',
          author: { name: 'Octo Cat', email: 'x@y' },
        },
        { sha: 's2', message: 'Their change', author: { name: 'Someone', email: 'some@one' } },
        { sha: 's3', message: "Merge branch 'main' into feature/x", author: { name: 'Octo Cat' } },
        { sha: 's4', message: 'Squashed (#9)', author: { email: 'octo@example.test' } },
      ],
    }),
    // A push without commits (newer payloads): resolved through the compare API.
    ev('PushEvent', 'acme/sdk', { ref: 'refs/heads/fix', before: 'c0', head: 'c2' }),
    ev('IssueCommentEvent', 'acme/sdk', {
      issue: { number: 7, title: 'Flaky test', pull_request: {} },
      comment: {
        id: 71,
        body: `Looks good\r\n${'x'.repeat(400)}`,
        html_url: 'https://github.com/acme/sdk/pull/7#c71',
      },
    }),
    ev('IssueCommentEvent', 'acme/sdk', {
      issue: { number: 7, title: 'Flaky test' },
      comment: { id: 72, body: '/ci rerun' },
    }),
    ev('PullRequestReviewEvent', 'acme/sdk', {
      pull_request: { number: 8, title: 'Their PR', user: { login: 'someone' } },
      review: { id: 81, state: 'APPROVED', submitted_at: '2026-11-05T14:00:00Z' },
    }),
    ev('PullRequestReviewEvent', 'acme/sdk', {
      pull_request: { number: 5, title: 'My PR', user: { login: 'OctoCat' } },
      review: { id: 82, state: 'COMMENTED' },
    }),
    ev('PullRequestEvent', 'acme/sdk', {
      action: 'closed',
      number: 5,
      pull_request: { number: 5, title: 'My PR', merged: true, merged_at: '2026-11-04T20:00:00Z' },
    }),
    ev('PullRequestEvent', 'acme/sdk', {
      action: 'closed',
      number: 6,
      pull_request: { merged: false },
    }),
    // Minimal payload: the title comes from the pulls API.
    ev(
      'PullRequestEvent',
      'acme/sdk',
      { action: 'opened', number: 5, pull_request: { number: 5 } },
      '2026-11-03T10:00:00Z',
    ),
    ev('PullRequestEvent', 'octocat/dotfiles', {
      action: 'opened',
      number: 1,
      pull_request: { title: 'mine' },
    }),
    ev(
      'PullRequestEvent',
      'acme/old',
      { action: 'opened', number: 2, pull_request: { title: 'old' } },
      '2026-10-20T10:00:00Z',
    ),
  ];
  const routes: Record<string, Route> = {
    '/users/octocat/events': (u) => (u.searchParams.get('page') === '1' ? events : []),
    '/repos/acme/sdk/pulls/5': () => ({ title: 'My PR', user: { login: 'octocat' } }),
    '/repos/acme/sdk/compare/c0...c2': () => ({
      commits: [
        {
          sha: 'c1',
          author: { login: 'octocat' },
          commit: { message: 'Fix it', author: { name: 'n', date: '2026-11-05T09:00:00Z' } },
        },
        {
          sha: 'c2',
          author: null,
          commit: { message: 'Not mine', author: { name: 'Other', email: 'o@o' } },
        },
      ],
    }),
  };

  test('maps events to records with the prototype filters', async () => {
    const f = fakeFetch(routes);
    const page = await github.sync(input(f));
    const byId = Object.fromEntries(page.records.map((r) => [r.externalId, r]));
    expect(Object.keys(byId).sort()).toEqual([
      'acme/sdk#5/merged',
      'acme/sdk#5/opened',
      'acme/sdk#8/review/81',
      'acme/sdk/comment/71',
      'acme/sdk@c1',
      'acme/sdk@s1',
    ]);
    expect(byId['acme/sdk#5/opened']).toMatchObject({
      kind: 'pull_request',
      title: 'Opened PR #5: My PR',
      url: 'https://github.com/acme/sdk/pull/5',
      eventTime: '2026-11-03T10:00:00Z',
      payload: { repo: 'acme/sdk', number: 5, action: 'opened' },
    });
    expect(byId['acme/sdk#5/merged']?.eventTime).toBe('2026-11-04T20:00:00Z');
    expect(byId['acme/sdk#8/review/81']).toMatchObject({
      kind: 'review',
      title: 'Reviewed PR #8 (approved): Their PR',
      eventTime: '2026-11-05T14:00:00Z',
    });
    const comment = byId['acme/sdk/comment/71'];
    expect(comment).toMatchObject({ kind: 'issue_comment', title: 'Commented on #7 Flaky test' });
    expect(comment?.summary?.length).toBe(240);
    expect(comment?.summary).not.toContain('\r');
    expect(byId['acme/sdk@s1']).toMatchObject({
      kind: 'commit',
      title: 'Add the parser',
      actor: 'x@y',
    });
    expect(byId['acme/sdk@c1']).toMatchObject({
      actor: 'octocat',
      eventTime: '2026-11-05T15:00:00Z', // the push, not the author date
    });

    // The push to main never hit the API; the newest event is the cursor.
    expect(f.seen.some((s) => s.includes('/compare/bbb'))).toBe(false);
    expect(page.cursor).toEqual({ since: '2026-11-05T15:00:00.000Z' }); // the newest event
    expect(page.more).toBe(false);
    // The feed reached the backfill start, so it isn't truncated.
    expect(page.historyFloor).toBeUndefined();
  });

  test('with a cursor, events from an hour before it on are read', async () => {
    const f = fakeFetch(routes);
    const page = await github.sync(input(f, { cursor: { since: '2026-11-04T00:30:00Z' } }));
    const ids = page.records.map((r) => r.externalId);
    expect(ids).not.toContain('acme/sdk#5/opened'); // 2026-11-03
    expect(ids).toContain('acme/sdk#5/merged');
  });

  test('event IDs are not in time order: a lower ID can be newer', async () => {
    // Pushes and PR events have separate ID ranges (seen on github.com).
    const feed = [
      {
        ...ev(
          'PushEvent',
          'acme/sdk',
          { ref: 'refs/heads/x', commits: [] },
          '2026-11-05T22:00:00Z',
        ),
        id: '26422486192',
      },
      {
        ...ev(
          'PullRequestEvent',
          'acme/sdk',
          { action: 'merged', number: 9, pull_request: { number: 9, title: 'Nine' } },
          '2026-11-06T05:00:00Z',
        ),
        id: '19303263554',
      },
    ];
    const f = fakeFetch({
      '/users/octocat/events': (u) => (u.searchParams.get('page') === '1' ? feed : []),
    });
    const page = await github.sync(input(f, { cursor: { since: '2026-11-05T21:00:00Z' } }));
    expect(page.records.map((r) => [r.externalId, r.eventTime])).toEqual([
      ['acme/sdk#9/merged', '2026-11-06T05:00:00Z'], // newer payloads: action 'merged', no merged_at
    ]);
    expect(page.cursor).toEqual({ since: '2026-11-06T05:00:00.000Z' });
  });

  test('a feed that runs out before the backfill start reports a history floor', async () => {
    const f = fakeFetch({
      ...routes,
      '/users/octocat/events': (u) =>
        u.searchParams.get('page') === '1' ? events.slice(0, 3) : [],
    });
    const page = await github.sync(input(f, { backfillFrom: '2026-01-01' }));
    expect(page.historyFloor?.toISOString()).toBe('2026-11-05T15:00:00.000Z');
  });

  test('a quiet feed keeps the old cursor', async () => {
    const f = fakeFetch({ '/users/octocat/events': () => [] });
    const page = await github.sync(input(f, { cursor: { since: '2026-11-05T00:00:00Z' } }));
    expect(page).toMatchObject({ records: [], cursor: { since: '2026-11-05T00:00:00Z' } });
  });
});

describe('github search streams', () => {
  const item = (
    n: number,
    repo: string,
    merged: string | null,
    created = '2026-02-01T00:00:00Z',
  ) => ({
    number: n,
    title: `PR ${n}`,
    repository_url: `https://api.github.com/repos/${repo}`,
    created_at: created,
    closed_at: merged,
    user: { login: 'octocat' },
    pull_request: { merged_at: merged },
  });

  test('walks 90-day windows up to today, then re-reads the last week', async () => {
    const queries: string[] = [];
    const f = fakeFetch({
      '/search/issues': (u) => {
        queries.push(u.searchParams.get('q') ?? '');
        return {
          items: [
            item(1, 'acme/sdk', '2026-03-02T10:00:00Z'),
            item(2, 'octocat/x', '2026-03-03T10:00:00Z'),
          ],
        };
      },
    });
    let cursor: Cursor = null;
    const ids: string[] = [];
    let pages = 0;
    for (;;) {
      const page = await github.sync(
        input(f, { stream: 'search:merged', cursor, backfillFrom: '2026-03-01' }),
      );
      pages++;
      ids.push(...page.records.map((r) => r.externalId));
      cursor = page.cursor;
      if (!page.more) break;
    }
    expect(queries).toEqual([
      'is:pr author:octocat merged:2026-03-01..2026-05-29',
      'is:pr author:octocat merged:2026-05-30..2026-08-27',
      'is:pr author:octocat merged:2026-08-28..2026-11-08',
    ]);
    expect(pages).toBe(3);
    expect(ids[0]).toBe('acme/sdk#1/merged'); // octocat/x is excluded
    expect(ids.length).toBe(3);
    expect(cursor).toEqual({ from: '2026-11-01', page: 1 });
  });

  test('a full page asks for the next one', async () => {
    const full = Array.from({ length: 100 }, (_, i) =>
      item(i + 1, 'acme/sdk', null, '2026-11-02T00:00:00Z'),
    );
    const f = fakeFetch({ '/search/issues': () => ({ items: full }) });
    const page = await github.sync(
      input(f, { stream: 'search:opened', cursor: { from: '2026-11-01', page: 1 } }),
    );
    expect(page.more).toBe(true);
    expect(page.cursor).toEqual({ from: '2026-11-01', page: 2 });
    expect(page.records[0]).toMatchObject({
      externalId: 'acme/sdk#1/opened',
      eventTime: '2026-11-02T00:00:00Z',
      payload: { repo: 'acme/sdk', number: 1, action: 'opened' },
    });
  });

  test('search and events produce identical records for the same PR', async () => {
    const f = fakeFetch({
      '/search/issues': () => ({ items: [item(5, 'acme/sdk', '2026-11-04T20:00:00Z')] }),
      '/users/octocat/events': () => [
        ev('PullRequestEvent', 'acme/sdk', {
          action: 'closed',
          number: 5,
          pull_request: {
            number: 5,
            title: 'PR 5',
            merged: true,
            merged_at: '2026-11-04T20:00:00Z',
          },
        }),
      ],
    });
    const fromSearch = await github.sync(input(f, { stream: 'search:merged' }));
    const fromEvents = await github.sync(input(f));
    expect(fromSearch.records).toEqual(fromEvents.records);
  });
});

describe('github errors', () => {
  test('401 is an auth error; an exhausted rate limit is a rate-limit error', async () => {
    const f = fakeFetch({});
    await expect(github.sync(input(f, { secret: 'wrong' }))).rejects.toBeInstanceOf(
      ConnectorAuthError,
    );
    const limited = fakeFetch({
      '/users/octocat/events': () =>
        new Response('API rate limit exceeded', {
          status: 403,
          headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1800000000' },
        }),
    });
    const err = await github.sync(input(limited)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConnectorRateLimitError);
    expect((err as ConnectorRateLimitError).retryAt?.toISOString()).toBe(
      '2027-01-15T08:00:00.000Z',
    );
  });

  test('other failures name the request, never the token', async () => {
    const f = fakeFetch({ '/users/octocat/events': () => new Response('boom', { status: 502 }) });
    const err = (await github.sync(input(f)).catch((e: unknown) => e)) as Error;
    expect(err.message).toBe('GET /users/octocat/events: 502 boom');
  });
});
