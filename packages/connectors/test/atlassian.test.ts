import { describe, expect, test } from 'bun:test';
import {
  type ConfluencePagesConfig,
  ConnectorAuthError,
  type Cursor,
  confluence,
  type JiraConfig,
  jira,
  jqlFor,
  type SyncInput,
} from '../src';
import { isoOf } from '../src/atlassian';

const now = new Date('2026-11-08T12:00:00Z');
const base = <C>(config: C, f: typeof fetch, over: Partial<SyncInput<C>> = {}): SyncInput<C> => ({
  config,
  secret: 'tok',
  stream: 'issues',
  cursor: null,
  identities: [],
  backfillFrom: '2026-11-01',
  now,
  fetch: f,
  log: { info() {}, warn() {} },
  ...over,
});

function fake(handler: (url: URL, init: RequestInit) => unknown) {
  const calls: { url: URL; init: RequestInit }[] = [];
  const f = (async (u: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(u instanceof Request ? u.url : String(u));
    calls.push({ url, init });
    const out = handler(url, init);
    return out instanceof Response ? out : Response.json(out);
  }) as typeof fetch;
  return Object.assign(f, { calls });
}

describe('atlassian helpers', () => {
  test('Jira timestamps', () => {
    expect(isoOf('2026-11-05T10:00:00.000+0000')).toBe('2026-11-05T10:00:00.000Z');
    expect(isoOf('2026-11-05T10:00:00.000-0500')).toBe('2026-11-05T15:00:00.000Z');
    expect(() => isoOf('nope')).toThrow();
  });
});

describe('jira', () => {
  const config: JiraConfig = jira.parseConfig({
    baseUrl: 'https://jira.example.test/',
    login: 'jdoe',
    watchProjects: ['pix'],
  });

  test('config, source key and JQL', () => {
    expect(config.baseUrl).toBe('https://jira.example.test');
    expect(jira.sourceKey(config)).toBe('jira:jira.example.test');
    expect(jqlFor(config, '2026-11-01')).toBe(
      '((assignee = currentUser() OR reporter = currentUser() OR watcher = currentUser()) OR project in (PIX)) AND updated >= "2026-11-01" ORDER BY updated ASC',
    );
    expect(() => jira.parseConfig({ baseUrl: 'ftp://x', login: 'a' })).toThrow();
  });

  const issue = (key: string, project: string, extra: object = {}) => ({
    key,
    fields: {
      summary: `Summary of ${key}`,
      created: '2026-11-03T09:00:00.000+0000',
      reporter: { name: 'someone' },
      project: { key: project },
      issuetype: { name: 'Bug' },
      comment: {
        comments: [
          {
            id: '1',
            body: 'mine\n  here',
            created: '2026-11-04T09:00:00.000+0000',
            author: { name: 'JDoe' },
          },
          {
            id: '2',
            body: 'theirs',
            created: '2026-11-04T10:00:00.000+0000',
            author: { name: 'other' },
          },
        ],
      },
    },
    changelog: {
      histories: [
        {
          id: '10',
          created: '2026-11-04T11:00:00.000+0000',
          author: { name: 'jdoe' },
          items: [
            { field: 'status', fromString: 'Open', toString: 'In Progress' },
            { field: 'Rank', fromString: 'a', toString: 'b' },
          ],
        },
        {
          id: '11',
          created: '2026-11-04T12:00:00.000+0000',
          author: { name: 'other' },
          items: [
            { field: 'assignee', fromString: null, toString: 'Other' },
            { field: 'status', fromString: 'In Progress', toString: 'Done' },
          ],
        },
        {
          id: '12',
          created: '2026-11-04T13:00:00.000+0000',
          author: { name: 'jdoe' },
          items: [{ field: 'Sprint', fromString: '1', toString: '2' }],
        },
      ],
    },
    ...extra,
  });

  test('mine always; others only in watched projects, and only status changes', async () => {
    const f = fake(() => ({ issues: [issue('PIX-1', 'PIX'), issue('ABC-2', 'ABC')], total: 2 }));
    const page = await jira.sync(base(config, f));
    const ids = page.records.map((r) => r.externalId);
    expect(ids).toEqual([
      'PIX-1/created', // someone else's, in a watched project
      'PIX-1/change/10',
      'PIX-1/change/11', // their status change only
      'PIX-1/comment/1',
      'PIX-1/comment/2',
      'ABC-2/change/10', // unwatched: only my own activity
      'ABC-2/comment/1',
    ]);
    const byId = Object.fromEntries(page.records.map((r) => [r.externalId, r]));
    expect(byId['PIX-1/change/10']).toMatchObject({
      kind: 'issue_change',
      title: 'PIX-1: status: Open → In Progress',
      eventTime: '2026-11-04T11:00:00.000Z',
      url: 'https://jira.example.test/browse/PIX-1',
      actor: 'jdoe',
    });
    expect(byId['PIX-1/change/11']?.title).toBe('PIX-1: status: In Progress → Done');
    expect(byId['PIX-1/comment/1']).toMatchObject({
      kind: 'issue_comment',
      summary: 'mine here',
      url: 'https://jira.example.test/browse/PIX-1?focusedCommentId=1',
    });

    // The request: POST search with the changelog, bearer auth.
    const [call] = f.calls;
    expect(call?.url.pathname).toBe('/rest/api/2/search');
    expect(new Headers(call?.init.headers).get('authorization')).toBe('Bearer tok');
    expect(JSON.parse(String(call?.init.body))).toMatchObject({
      startAt: 0,
      maxResults: 50,
      expand: ['changelog'],
    });
    // Caught up: next time from yesterday.
    expect(page).toMatchObject({ more: false, cursor: { since: '2026-11-07', startAt: 0 } });
  });

  test('pages through results, and basic auth when asked', async () => {
    const fifty = Array.from({ length: 50 }, (_, i) => issue(`PIX-${i}`, 'PIX'));
    const f = fake(() => ({ issues: fifty, total: 120 }));
    const basic = jira.parseConfig({
      baseUrl: 'https://jira.example.test',
      login: 'jdoe',
      auth: 'basic',
    });
    const page = await jira.sync(
      base(basic, f, { cursor: { since: '2026-10-01', startAt: 50 } as Cursor }),
    );
    expect(page).toMatchObject({ more: true, cursor: { since: '2026-10-01', startAt: 100 } });
    expect(new Headers(f.calls[0]?.init.headers).get('authorization')).toBe(
      `Basic ${Buffer.from('jdoe:tok').toString('base64')}`,
    );
  });

  test('401 and 403 are auth errors', async () => {
    const f = fake(() => new Response('nope', { status: 403 }));
    await expect(jira.sync(base(config, f))).rejects.toBeInstanceOf(ConnectorAuthError);
  });
});

describe('confluence', () => {
  const config: ConfluencePagesConfig = confluence.parseConfig({
    baseUrl: 'https://wiki.example.test',
    login: 'jdoe',
    excludeAncestorIds: ['999'],
  });
  const page = (id: string, by: string, n: number, ancestors: string[] = []) => ({
    id,
    type: 'page',
    title: `Page ${id}`,
    space: { key: 'ENG' },
    ancestors: ancestors.map((a) => ({ id: a })),
    version: { number: n, when: '2026-11-05T10:00:00.000Z', by: { username: by } },
    _links: { webui: `/display/ENG/Page+${id}` },
  });

  test('pages: mine only, not under the work-log tree; created vs edited', async () => {
    const f = fake(() => ({
      results: [
        page('1', 'jdoe', 1),
        page('2', 'jdoe', 4),
        page('3', 'other', 2),
        page('4', 'jdoe', 2, ['999']),
      ],
      size: 4,
    }));
    const p = await confluence.sync(base(config, f, { stream: 'pages' }));
    expect(p.records.map((r) => [r.externalId, r.title])).toEqual([
      ['page/1/v1', 'Created “Page 1” [ENG]'],
      ['page/2/v4', 'Edited “Page 2” [ENG]'],
    ]);
    expect(p.records[0]?.url).toBe('https://wiki.example.test/display/ENG/Page+1');
    const cql = f.calls[0]?.url.searchParams.get('cql');
    expect(cql).toBe(
      'contributor = currentUser() AND type = page AND lastmodified >= "2026-10-31" ORDER BY lastmodified ASC',
    );
  });

  test('comments', async () => {
    const f = fake(() => ({
      results: [
        {
          id: '50',
          type: 'comment',
          title: 'Re: Page 1',
          version: { number: 1, when: '2026-11-05T11:00:00.000Z', by: { username: 'jdoe' } },
          container: { id: '1', title: 'Page 1', _links: { webui: '/display/ENG/Page+1' } },
        },
      ],
      size: 1,
    }));
    const p = await confluence.sync(base(config, f, { stream: 'comments' }));
    expect(p.records[0]).toMatchObject({
      externalId: 'comment/50',
      kind: 'page_comment',
      title: 'Commented on “Page 1”',
      url: 'https://wiki.example.test/display/ENG/Page+1',
    });
  });
});
