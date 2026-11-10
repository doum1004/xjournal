import { describe, expect, test } from 'bun:test';
import {
  authorizeUrl,
  ConnectorAuthError,
  ConnectorRateLimitError,
  type Cursor,
  cleanDescription,
  eventRecord,
  exchangeCode,
  type GcalConfig,
  GOOGLE,
  gcal,
  isNoise,
  oauthToken,
  parseOAuthClient,
  pkcePair,
  readable,
  type SlackConfig,
  type SyncInput,
  slack,
} from '../src';

const now = new Date('2026-11-08T12:00:00Z');
const base = <C>(config: C, f: typeof fetch, over: Partial<SyncInput<C>> = {}): SyncInput<C> => ({
  config,
  secret: 'tok',
  stream: 'x',
  cursor: null,
  identities: [],
  backfillFrom: '2026-11-05',
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

const header = (init: RequestInit, name: string) =>
  (init.headers as Record<string, string> | undefined)?.[name];

describe('oauth', () => {
  const google = {
    name: 'google',
    tokenUrl: 'https://oauth.test/token',
    clientAuth: 'body' as const,
  };

  test('a bare token is used as is', async () => {
    const f = fake(() => {
      throw new Error('no request expected');
    });
    expect(await oauthToken(base({}, f, { secret: 'ya29.abc' }), google)).toBe('ya29.abc');
  });

  test('refreshes, stores the new secret and reuses it until it expires', async () => {
    const f = fake((url, init) => {
      expect(url.href).toBe('https://oauth.test/token');
      const form = new URLSearchParams(String(init.body));
      expect(form.get('grant_type')).toBe('refresh_token');
      expect(form.get('client_secret')).toBe('cs');
      return { access_token: 'fresh', expires_in: 3600, refresh_token: 'rt2' };
    });
    const saved: string[] = [];
    const secret = JSON.stringify({ client_id: 'ci', client_secret: 'cs', refresh_token: 'rt1' });
    const input = base({}, f, { secret, saveSecret: async (s) => void saved.push(s) });
    expect(await oauthToken(input, google)).toBe('fresh');
    const stored = JSON.parse(saved[0] ?? '{}');
    expect(stored).toMatchObject({ access_token: 'fresh', refresh_token: 'rt2', client_id: 'ci' });
    expect(stored.expires_at).toBe('2026-11-08T13:00:00.000Z');

    // Still valid: no request.
    const again = base({}, f, { secret: saved[0] as string });
    expect(await oauthToken(again, google)).toBe('fresh');
    expect(f.calls.length).toBe(1);
    // Within five minutes of expiry: refresh.
    const later = base({}, f, {
      secret: saved[0] as string,
      now: new Date('2026-11-08T12:56:00Z'),
    });
    expect(await oauthToken(later, google)).toBe('fresh');
    expect(f.calls.length).toBe(2);
  });

  test('a refused refresh or a malformed secret asks to reconnect', async () => {
    const f = fake(() => Response.json({ error: 'invalid_grant' }, { status: 400 }));
    const secret = JSON.stringify({ client_id: 'ci', client_secret: 'cs', refresh_token: 'x' });
    await expect(oauthToken(base({}, f, { secret }), google)).rejects.toBeInstanceOf(
      ConnectorAuthError,
    );
    await expect(oauthToken(base({}, f, { secret: '{nope' }), google)).rejects.toBeInstanceOf(
      ConnectorAuthError,
    );
    const noRefresh = JSON.stringify({ client_id: 'ci', client_secret: 'cs' });
    await expect(oauthToken(base({}, f, { secret: noRefresh }), google)).rejects.toBeInstanceOf(
      ConnectorAuthError,
    );
  });
});

describe('oauth sign-in', () => {
  const client = { client_id: 'ci', client_secret: 'cs' };

  test('client files: Google downloads and plain JSON', () => {
    expect(parseOAuthClient(JSON.stringify({ installed: { ...client, project_id: 'p' } }))).toEqual(
      client,
    );
    expect(parseOAuthClient(JSON.stringify(client))).toEqual(client);
    expect(() => parseOAuthClient('{"client_id":"x"}')).toThrow();
  });

  test('PKCE pair and consent URL', async () => {
    const { verifier, challenge } = await pkcePair();
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const digest = new Bun.CryptoHasher('sha256').update(verifier).digest('base64url');
    expect(challenge).toBe(digest);
    const u = new URL(
      authorizeUrl(GOOGLE, client, 'http://localhost:8765/callback', 'st', challenge),
    );
    expect(u.origin + u.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(Object.fromEntries(u.searchParams)).toMatchObject({
      response_type: 'code',
      client_id: 'ci',
      redirect_uri: 'http://localhost:8765/callback',
      state: 'st',
      code_challenge_method: 'S256',
      scope: 'https://www.googleapis.com/auth/calendar.events.readonly',
      access_type: 'offline',
      prompt: 'consent',
    });
  });

  test('exchanging the code builds the stored secret', async () => {
    const f = fake((_url, init) => {
      const form = new URLSearchParams(String(init.body));
      expect(Object.fromEntries(form)).toEqual({
        grant_type: 'authorization_code',
        code: 'the-code',
        redirect_uri: 'http://localhost:8765/callback',
        code_verifier: 'v',
        client_id: 'ci',
        client_secret: 'cs',
      });
      return { access_token: 'a', refresh_token: 'r', expires_in: 3600 };
    });
    const secret = await exchangeCode(
      { fetch: f, now },
      GOOGLE,
      client,
      'the-code',
      'http://localhost:8765/callback',
      'v',
    );
    expect(JSON.parse(secret)).toEqual({
      ...client,
      refresh_token: 'r',
      access_token: 'a',
      expires_at: '2026-11-08T13:00:00.000Z',
    });
    const none = fake(() => ({ access_token: 'a' }));
    await expect(exchangeCode({ fetch: none, now }, GOOGLE, client, 'c', 'r', 'v')).rejects.toThrow(
      /no refresh token/,
    );
  });
});

describe('slack', () => {
  const config: SlackConfig = slack.parseConfig({
    workspace: 'https://Acme.slack.com/',
    userId: 'U0ME',
    skipChannels: ['#private-*'],
  });
  const ts = (iso: string, frac = '000100') => `${Date.parse(iso) / 1000}.${frac}`;

  test('config, source key and identity', () => {
    expect(config.workspace).toBe('acme.slack.com');
    expect(slack.parseConfig({ workspace: 'acme', userId: 'W01' }).workspace).toBe(
      'acme.slack.com',
    );
    expect(slack.sourceKey(config)).toBe('slack:acme.slack.com');
    expect(slack.defaultIdentity?.(config)).toEqual({ accountKey: 'U0ME', aliases: [] });
    expect(() => slack.parseConfig({ workspace: 'acme', userId: 'alex' })).toThrow();
  });

  test('readable text and noise', () => {
    expect(
      readable('ping <@U123> in <#C1|ops>: see <https://x.test/a|the doc> &amp; <https://y.test>'),
    ).toBe('ping @someone in #ops: see the doc & https://y.test');
    expect(isNoise(config, 'thanks!', false)).toBe(true);
    expect(isNoise(config, ':pray: :tada:', false)).toBe(true);
    expect(isNoise(config, ':pray:', true)).toBe(false);
    expect(isNoise(config, '+1', false)).toBe(true);
    expect(isNoise(config, 'Thanks, merged the fix for the signing secret', false)).toBe(false);
  });

  // Two channels; #dev has my post, a thread with my new reply, others' posts and noise.
  const dev = { id: 'C1', name: 'dev' };
  const t = {
    old: ts('2026-11-04T10:00:00Z'), // before `since`, but its thread got a new reply
    mine: ts('2026-11-06T09:00:00Z'),
    other: ts('2026-11-06T09:05:00Z'),
    thanks: ts('2026-11-06T09:06:00Z'),
    join: ts('2026-11-06T09:07:00Z'),
    reply: ts('2026-11-06T11:00:00Z', '000200'),
  };
  function api(over: { history?: (url: URL) => unknown } = {}) {
    return fake((url) => {
      const m = url.pathname.replace('/api/', '');
      if (m === 'auth.test') return { ok: true, user_id: 'U0ME', url: 'https://acme.slack.com/' };
      if (m === 'users.conversations') {
        expect(url.searchParams.get('types')).toBe('public_channel,private_channel');
        return {
          ok: true,
          channels: [dev, { id: 'C2', name: 'private-notes' }, { id: 'C3', name: 'support' }],
          response_metadata: { next_cursor: '' },
        };
      }
      if (m === 'conversations.history') {
        if (over.history) return over.history(url);
        if (url.searchParams.get('channel') === 'C3') return { ok: true, messages: [] };
        return {
          ok: true,
          has_more: false,
          messages: [
            {
              type: 'message',
              ts: t.old,
              user: 'U9',
              text: 'question',
              thread_ts: t.old,
              reply_count: 3,
              reply_users: ['U9', 'U0ME'],
              latest_reply: t.reply,
            },
            {
              type: 'message',
              ts: t.mine,
              user: 'U0ME',
              text: 'Raised the expired <#C9|signing> secret',
            },
            { type: 'message', ts: t.other, user: 'U9', text: 'not mine' },
            { type: 'message', ts: t.thanks, user: 'U0ME', text: 'thanks!' },
            { type: 'message', subtype: 'channel_join', ts: t.join, user: 'U0ME', text: 'joined' },
          ],
        };
      }
      if (m === 'conversations.replies') {
        expect(url.searchParams.get('ts')).toBe(t.old);
        return {
          ok: true,
          messages: [
            { type: 'message', ts: t.old, user: 'U9', text: 'question', thread_ts: t.old },
            {
              type: 'message',
              ts: t.reply,
              user: 'U0ME',
              text: 'Fixed in the 2026.6 build',
              thread_ts: t.old,
            },
          ],
        };
      }
      throw new Error(`unexpected ${url}`);
    });
  }

  test('a round over the channels: my posts and thread replies, one channel per page', async () => {
    const f = api();
    const input = (cursor: Cursor) => base(config, f, { stream: 'messages', cursor });
    const p1 = await slack.sync(input(null));
    expect(p1.more).toBe(true);
    expect(p1.records.map((r) => [r.externalId, r.title])).toEqual([
      [`C1/${t.reply}`, 'Replied in a thread in #dev'],
      [`C1/${t.mine}`, 'Posted in #dev'],
    ]);
    const [reply, post] = p1.records;
    expect(post?.url).toBe(`https://acme.slack.com/archives/C1/p${t.mine.replace('.', '')}`);
    expect(reply?.url).toContain(`?thread_ts=${t.old}&cid=C1`);
    expect(post?.summary).toBe('Raised the expired #signing secret');
    expect(post?.actor).toBe('U0ME');
    expect(post?.payload).toEqual({ channel: 'dev', channelId: 'C1' });
    expect(post?.eventTime).toBe('2026-11-06T09:00:00.000Z');

    // History reaches back threadLookbackDays before `since` (a day before the backfill).
    const hist = f.calls.find((c) => c.url.pathname.endsWith('conversations.history'));
    const since = Date.parse('2026-11-04T00:00:00Z') / 1000;
    expect(hist?.url.searchParams.get('oldest')).toBe(`${since - 3 * 86_400}.000000`);
    expect(header(hist?.init ?? {}, 'Authorization')).toBe('Bearer tok');

    // #private-notes is skipped; #support is next and last.
    const p2 = await slack.sync(input(p1.cursor));
    expect(p2.records).toEqual([]);
    expect(p2.more).toBe(false);
    expect(p2.cursor).toEqual({ since: `${now.getTime() / 1000}.000000` });
    expect(f.calls.some((c) => c.url.searchParams.get('channel') === 'C2')).toBe(false);
  });

  test('history pages within a channel, and skips a channel it cannot read', async () => {
    let n = 0;
    const f = api({
      history: (url) => {
        n++;
        if (url.searchParams.get('channel') === 'C3') return { ok: false, error: 'not_in_channel' };
        return url.searchParams.get('cursor') === 'p2'
          ? { ok: true, messages: [], has_more: false }
          : { ok: true, messages: [], has_more: true, response_metadata: { next_cursor: 'p2' } };
      },
    });
    const input = (cursor: Cursor) => base(config, f, { stream: 'messages', cursor });
    const p1 = await slack.sync(input(null));
    expect((p1.cursor as { round: { page: string } }).round.page).toBe('p2');
    const p2 = await slack.sync(input(p1.cursor));
    expect(p2.more).toBe(true);
    const p3 = await slack.sync(input(p2.cursor));
    expect(p3.more).toBe(false);
    expect(n).toBe(3);
  });

  test('auth and rate-limit errors', async () => {
    const bad = fake(() => ({ ok: false, error: 'invalid_auth' }));
    await expect(slack.sync(base(config, bad, { stream: 'messages' }))).rejects.toBeInstanceOf(
      ConnectorAuthError,
    );
    const slow = fake(() => new Response('', { status: 429, headers: { 'retry-after': '30' } }));
    await expect(slack.sync(base(config, slow, { stream: 'messages' }))).rejects.toBeInstanceOf(
      ConnectorRateLimitError,
    );
  });

  test('DMs only when enabled', async () => {
    const dms = slack.parseConfig({ workspace: 'acme', userId: 'U0ME', includeDms: true });
    const f = fake((url) => {
      if (url.pathname.endsWith('auth.test')) return { ok: true, user_id: 'U0ME' };
      expect(url.searchParams.get('types')).toBe('public_channel,private_channel,mpim,im');
      return { ok: true, channels: [] };
    });
    const p = await slack.sync(base(dms, f, { stream: 'messages' }));
    expect(p.more).toBe(false);
  });
});

describe('google calendar', () => {
  const config: GcalConfig = gcal.parseConfig({ account: 'Me@Acme.test' });
  const me = { email: 'me@acme.test', self: true, responseStatus: 'accepted' as const };
  const ann = { email: 'ann@acme.test', displayName: 'Ann', responseStatus: 'accepted' as const };
  const room = { email: 'room@resource.test', resource: true };
  const ev = (id: string, extra: object = {}) => ({
    id,
    status: 'confirmed' as const,
    eventType: 'default',
    htmlLink: `https://calendar.test/${id}`,
    summary: `Meeting ${id}`,
    start: { dateTime: '2026-11-06T10:00:00+01:00' },
    end: { dateTime: '2026-11-06T10:30:00+01:00' },
    attendees: [me, ann, room],
    organizer: { email: 'Ann@acme.test' },
    ...extra,
  });

  test('config and source key', () => {
    expect(gcal.sourceKey(config)).toBe('gcal:me@acme.test');
    expect(
      gcal.sourceKey(gcal.parseConfig({ account: 'me@acme.test', calendarId: 'team@x' })),
    ).toBe('gcal:me@acme.test/team@x');
    expect(gcal.defaultIdentity?.(config)?.accountKey).toBe('me@acme.test');
  });

  test('keeps meetings, drops declined, solo, focus, OOO, all-day and lunch', () => {
    const r = eventRecord(config, ev('a', { recurringEventId: 'r1' }));
    expect(r).toEqual({
      externalId: 'primary/a',
      kind: 'meeting',
      eventTime: '2026-11-06T09:00:00.000Z',
      title: 'Meeting a',
      url: 'https://calendar.test/a',
      actor: 'me@acme.test',
      payload: {
        calendar: 'primary',
        minutes: 30,
        attendees: 1,
        with: ['Ann'],
        organizer: 'ann@acme.test',
        response: 'accepted',
        recurring: true,
      },
    });
    const drop = [
      ev('b', { attendees: [{ ...me, responseStatus: 'declined' }, ann] }),
      ev('c', { attendees: [me, room] }),
      ev('d', { eventType: 'focusTime' }),
      ev('e', { eventType: 'outOfOffice' }),
      ev('f', { start: { date: '2026-11-06' }, end: { date: '2026-11-07' } }),
      ev('g', { summary: 'Lunch with team' }),
      ev('h', { status: 'cancelled' }),
    ];
    for (const e of drop) expect(eventRecord(config, e)).toBeNull();
  });

  test('descriptions lose join details, links and HTML', () => {
    const d =
      'Agenda:<br>Plan the <b>2026.6</b> release<br>Join Zoom Meeting https://zoom.us/j/123?pwd=abc<br>Meeting ID: 123 456<br>Passcode: 999<br>Notes: https://docs.test/x';
    expect(cleanDescription(d)).toBe('Agenda: Plan the 2026.6 release Notes:');
    expect(eventRecord(config, ev('a', { description: d }))?.summary).toBe(
      'Agenda: Plan the 2026.6 release Notes:',
    );
  });

  test('pages through events up to now, then starts from yesterday', async () => {
    const f = fake((url, init) => {
      if (url.pathname.endsWith('/token')) {
        return { access_token: 'g-access', expires_in: 3600 };
      }
      expect(url.pathname).toBe('/calendar/v3/calendars/primary/events');
      expect(header(init, 'Authorization')).toBe('Bearer g-access');
      expect(url.searchParams.get('timeMin')).toBe('2026-11-04T00:00:00Z');
      expect(url.searchParams.get('timeMax')).toBe(now.toISOString());
      expect(url.searchParams.get('singleEvents')).toBe('true');
      return url.searchParams.get('pageToken')
        ? { items: [ev('b2')] }
        : { items: [ev('a1'), ev('x', { status: 'cancelled' })], nextPageToken: 'n2' };
    });
    let secret = JSON.stringify({ client_id: 'ci', client_secret: 'cs', refresh_token: 'rt' });
    const input = (cursor: Cursor) =>
      base(config, f, {
        stream: 'events',
        cursor,
        secret,
        saveSecret: async (s) => {
          secret = s;
        },
      });
    const p1 = await gcal.sync(input(null));
    expect(p1.records.map((r) => r.externalId)).toEqual(['primary/a1']);
    expect(p1.more).toBe(true);
    const p2 = await gcal.sync(input(p1.cursor));
    expect(p2.records.map((r) => r.externalId)).toEqual(['primary/b2']);
    expect(p2.more).toBe(false);
    expect(p2.cursor).toEqual({ since: '2026-11-07' });
    // One token refresh for both pages: the second reused the stored access token.
    expect(f.calls.filter((c) => c.url.pathname.endsWith('/token')).length).toBe(1);
  });
});
