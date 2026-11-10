import type { RecordInput } from '@xjournal/core';
import { z } from 'zod';
import { clip, oneLine } from './atlassian';
import { rateLimited, requestJson } from './http';
import {
  ConnectorAuthError,
  type Cursor,
  defineConnector,
  type SyncInput,
  type SyncPage,
} from './sdk';

// Slack (spec §8.2, §8.7): the messages you sent in the channels you belong to. Works without
// the `search:read` scope, which some orgs deny: it lists your conversations, reads each one's
// history since the last sync and keeps your own messages, plus your replies in threads with
// new replies. DMs are off by default. Messages are stored as a short summary, the permalink
// and metadata, never in full (spec §8.6).
//
// Scopes of the user token: channels:read, groups:read, channels:history, groups:history; with
// DMs also im:read, mpim:read, im:history, mpim:history.
//
// One stream, `messages`. A sync is a round over your conversations, one history page per
// call, so a rate limit or crash resumes from the channel it reached.

const zPatterns = z.array(z.string().trim().min(1)).default([]);

export const zSlackConfig = z.object({
  /** Your workspace host, e.g. acme.slack.com (or acme.enterprise.slack.com). */
  workspace: z
    .string()
    .trim()
    .min(1)
    .transform((w) => {
      const host = w
        .replace(/^https?:\/\//, '')
        .replace(/\/.*$/, '')
        .toLowerCase();
      return host.includes('.') ? host : `${host}.slack.com`;
    }),
  /** Your Slack member ID (Profile → ⋮ → Copy member ID), e.g. U0123ABCD. */
  userId: z
    .string()
    .trim()
    .regex(/^[UW][A-Z0-9]{2,}$/, 'a Slack member ID like U0123ABCD'),
  /** Read direct and group messages too. */
  includeDms: z.boolean().default(false),
  /** Channel names to skip; `*` matches anything (e.g. "private-*", "random"). */
  skipChannels: zPatterns,
  /** If set, only these channel names are read. */
  onlyChannels: zPatterns,
  /** How far back to look for threads that got new replies. */
  threadLookbackDays: z.number().int().min(0).max(30).default(3),
  /** Messages whose whole text matches one of these (case-insensitive regexes) are noise. */
  ignorePatterns: z
    .array(z.string())
    .default([
      '^(thanks?( you)?|thx|ty|tysm|ok(ay)?|kk?|lgtm|nice|great|cool|sure|np|done|yes|no|yep|nope|hi|hello|hey|morning|bye)[\\s!.]*$',
      '^\\+1$',
    ]),
});
export type SlackConfig = z.infer<typeof zSlackConfig>;

const API = 'https://slack.com/api/';
const PAGE = 200;
const SUMMARY_CHARS = 240;
/** Message subtypes that are still something you wrote. */
const KEPT_SUBTYPES = new Set(['thread_broadcast', 'file_share', 'me_message']);

interface SlackChannel {
  id: string;
  name?: string;
  is_im?: boolean;
  is_mpim?: boolean;
  is_archived?: boolean;
}
interface SlackMessage {
  type?: string;
  subtype?: string;
  ts: string;
  user?: string;
  bot_id?: string;
  text?: string;
  thread_ts?: string;
  reply_count?: number;
  reply_users?: string[];
  latest_reply?: string;
  files?: unknown[];
}
interface SlackResponse {
  ok: boolean;
  error?: string;
  has_more?: boolean;
  response_metadata?: { next_cursor?: string };
}
type Page<K extends string, T> = SlackResponse & { [P in K]?: T[] };

interface Conversation {
  id: string;
  name: string;
}
interface MessagesCursor {
  /** Slack timestamp: messages after this one are new. */
  since: string;
  /** The round in progress, if any. */
  round?: {
    /** Becomes `since` when the round ends. */
    started: string;
    queue: Conversation[];
    page: string | null;
  };
}

/** Slack's error codes that mean the token is no good. */
const AUTH_ERRORS = new Set([
  'not_authed',
  'invalid_auth',
  'account_inactive',
  'token_revoked',
  'token_expired',
  'no_permission',
  'missing_scope',
  'not_allowed_token_type',
  'ekm_access_denied',
]);
/** Errors that skip one conversation instead of failing the sync. */
const SKIP_ERRORS = new Set(['channel_not_found', 'not_in_channel', 'is_archived']);

class SlackSkip extends Error {}

async function call<T extends SlackResponse>(
  input: SyncInput<SlackConfig>,
  method: string,
  params: Record<string, string | number | boolean | undefined>,
): Promise<T> {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') q.set(k, String(v));
  const url = `${API}${method}?${q}`;
  const res = await requestJson<T>(input, url, { token: input.secret ?? '' });
  if (!res) throw new Error(`slack ${method}: empty response`);
  if (res.ok) return res;
  const err = res.error ?? 'unknown_error';
  if (AUTH_ERRORS.has(err)) throw new ConnectorAuthError(`slack ${method}: ${err}`);
  if (err === 'ratelimited') {
    throw rateLimited(`slack ${method}`, new Response(null, { status: 429 }));
  }
  if (SKIP_ERRORS.has(err)) throw new SlackSkip(err);
  throw new Error(`slack ${method}: ${err}`);
}

const globRe = (p: string) =>
  new RegExp(
    `^${p
      .replace(/^#/, '')
      .split('*')
      .map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
      .join('.*')}$`,
    'i',
  );

export function channelAllowed(config: SlackConfig, name: string): boolean {
  if (config.skipChannels.some((p) => globRe(p).test(name))) return false;
  return !config.onlyChannels.length || config.onlyChannels.some((p) => globRe(p).test(name));
}

/** Slack mrkdwn → plain text: <@U1> → @someone, <#C1|name> → #name, <url|label> → label. */
export function readable(text: string): string {
  return oneLine(
    text
      .replace(/<@[A-Z0-9]+(?:\|([^>]+))?>/g, (_, n?: string) => `@${n ?? 'someone'}`)
      .replace(/<#[A-Z0-9]+(?:\|([^>]*))?>/g, (_, n?: string) => `#${n || 'channel'}`)
      .replace(/<!(here|channel|everyone)[^>]*>/g, '@$1')
      .replace(/<!subteam\^[A-Z0-9]+(?:\|([^>]+))?>/g, (_, n?: string) => n ?? '@team')
      .replace(/<([^|>]+)\|([^>]+)>/g, '$2')
      .replace(/<([^>]+)>/g, '$1')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&'),
  );
}

/** True for messages with nothing to log: emoji only, greetings, thanks, "+1". */
export function isNoise(config: SlackConfig, text: string, hasFiles: boolean): boolean {
  const bare = readable(text)
    .replace(/:[a-z0-9_+'-]+:/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!bare) return !hasFiles;
  return config.ignorePatterns.some((p) => new RegExp(p, 'i').test(bare));
}

export const tsOf = (d: Date) => `${Math.floor(d.getTime() / 1000)}.000000`;
const isoOfTs = (ts: string) => new Date(Math.round(Number(ts) * 1000)).toISOString();
const minusDays = (ts: string, days: number) => `${Math.floor(Number(ts)) - days * 86_400}.000000`;

export function permalink(config: SlackConfig, channel: string, m: SlackMessage): string {
  const base = `https://${config.workspace}/archives/${channel}/p${m.ts.replace('.', '')}`;
  return m.thread_ts && m.thread_ts !== m.ts
    ? `${base}?thread_ts=${m.thread_ts}&cid=${channel}`
    : base;
}

export function messageRecord(
  config: SlackConfig,
  channel: Conversation,
  m: SlackMessage,
): RecordInput | null {
  if (m.user !== config.userId || m.bot_id) return null;
  if (m.subtype && !KEPT_SUBTYPES.has(m.subtype)) return null;
  const text = m.text ?? '';
  if (isNoise(config, text, !!m.files?.length)) return null;
  const reply = !!m.thread_ts && m.thread_ts !== m.ts && m.subtype !== 'thread_broadcast';
  const where = channel.name.startsWith('@') ? `a DM` : `#${channel.name}`;
  return {
    externalId: `${channel.id}/${m.ts}`,
    kind: 'message',
    eventTime: isoOfTs(m.ts),
    title: reply ? `Replied in a thread in ${where}` : `Posted in ${where}`,
    url: permalink(config, channel.id, m),
    actor: config.userId,
    summary: clip(readable(text), SUMMARY_CHARS) || `(${m.files?.length ?? 0} file(s))`,
    payload: {
      channel: channel.name,
      channelId: channel.id,
      ...(m.thread_ts ? { thread: m.thread_ts } : {}),
      ...(m.files?.length ? { files: m.files.length } : {}),
    },
  };
}

async function listConversations(input: SyncInput<SlackConfig>): Promise<Conversation[]> {
  const { config } = input;
  const types = ['public_channel', 'private_channel', ...(config.includeDms ? ['mpim', 'im'] : [])];
  const out: Conversation[] = [];
  let cursor: string | undefined;
  do {
    const res = await call<Page<'channels', SlackChannel>>(input, 'users.conversations', {
      types: types.join(','),
      exclude_archived: true,
      limit: PAGE,
      cursor,
    });
    for (const c of res.channels ?? []) {
      const name = c.is_im ? '@dm' : c.is_mpim ? '@group-dm' : (c.name ?? c.id);
      if (!c.is_im && !c.is_mpim && !channelAllowed(config, name)) continue;
      out.push({ id: c.id, name });
    }
    cursor = res.response_metadata?.next_cursor || undefined;
  } while (cursor);
  return out;
}

async function threadReplies(
  input: SyncInput<SlackConfig>,
  channel: Conversation,
  parent: SlackMessage,
  since: string,
): Promise<RecordInput[]> {
  const out: RecordInput[] = [];
  let cursor: string | undefined;
  do {
    const res = await call<Page<'messages', SlackMessage>>(input, 'conversations.replies', {
      channel: channel.id,
      ts: parent.ts,
      oldest: since,
      limit: PAGE,
      cursor,
    });
    for (const m of res.messages ?? []) {
      if (m.ts === parent.ts) continue;
      const r = messageRecord(input.config, channel, m);
      if (r) out.push(r);
    }
    cursor = (res.has_more && res.response_metadata?.next_cursor) || undefined;
  } while (cursor);
  return out;
}

async function syncMessages(input: SyncInput<SlackConfig>): Promise<SyncPage> {
  const { config } = input;
  const c = (input.cursor as MessagesCursor | null) ?? {
    // From the start of the backfill day, a day early for time zones west of UTC.
    since: minusDays(tsOf(new Date(`${input.backfillFrom}T00:00:00Z`)), 1),
  };
  let round = c.round;
  if (!round) {
    const me = await call<SlackResponse & { user_id?: string }>(input, 'auth.test', {});
    if (me.user_id && me.user_id !== config.userId) {
      input.log.warn('slack: the token belongs to another member than userId', {
        token: me.user_id,
        userId: config.userId,
      });
    }
    round = { started: tsOf(input.now), queue: await listConversations(input), page: null };
  }

  const channel = round.queue[0];
  if (!channel) {
    return { records: [], cursor: { since: round.started } as unknown as Cursor, more: false };
  }

  let records: RecordInput[] = [];
  let next: string | null = null;
  try {
    const res = await call<Page<'messages', SlackMessage>>(input, 'conversations.history', {
      channel: channel.id,
      oldest: minusDays(c.since, config.threadLookbackDays),
      limit: PAGE,
      cursor: round.page ?? undefined,
    });
    for (const m of res.messages ?? []) {
      if (m.ts > c.since) {
        const r = messageRecord(config, channel, m);
        if (r) records.push(r);
      }
      const joined = m.user === config.userId || m.reply_users?.includes(config.userId);
      if (m.reply_count && joined && (m.latest_reply ?? '0') > c.since) {
        records.push(...(await threadReplies(input, channel, m, c.since)));
      }
    }
    next = (res.has_more && res.response_metadata?.next_cursor) || null;
  } catch (e) {
    if (!(e instanceof SlackSkip)) throw e;
    input.log.warn('slack: skipped a conversation', { channel: channel.name, error: e.message });
  }

  // A reply also sent to the channel is in both the history and its thread.
  records = [...new Map(records.map((r) => [r.externalId, r])).values()];
  const queue = next ? round.queue : round.queue.slice(1);
  if (!queue.length) {
    return { records, cursor: { since: round.started } as unknown as Cursor, more: false };
  }
  const cursor = { since: c.since, round: { started: round.started, queue, page: next } };
  return { records, cursor: cursor as unknown as Cursor, more: true };
}

export const slack = defineConnector<SlackConfig>({
  describe: () => ({
    kind: 'slack',
    displayName: 'Slack',
    authTypes: ['oauth'],
    streams: [
      { key: 'messages', description: 'Messages you sent in your channels (DMs off by default)' },
    ],
    policy: { fullText: false },
  }),
  parseConfig: (raw) => zSlackConfig.parse(raw),
  sourceKey: (config) => `slack:${config.workspace}`,
  configSchema: () => z.toJSONSchema(zSlackConfig, { io: 'input' }) as Record<string, unknown>,
  defaultIdentity: (config) => ({ accountKey: config.userId, aliases: [] }),
  sync(input) {
    if (input.stream !== 'messages') throw new Error(`slack: unknown stream ${input.stream}`);
    return syncMessages(input);
  },
});
