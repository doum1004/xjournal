import type { RecordInput } from '@xjournal/core';
import { z } from 'zod';
import { clip, dayBefore, oneLine } from './atlassian';
import { HttpError, requestJson } from './http';
import { type OAuthProvider, oauthToken } from './oauth';
import {
  ConnectorAuthError,
  type Cursor,
  defineConnector,
  type SyncInput,
  type SyncPage,
} from './sdk';

// Zoom (spec §8.2, §8.7): AI Companion meeting summaries, as decisions and next steps. Zoom's
// API gives a meeting's summary to its host (and to admins), so this covers the meetings you
// hosted; summaries of other people's meetings come in through the agent bridge (spec §8.8
// tier 3). Meetings with no summary are skipped. Stores the overview, the topic headings and
// the next steps, shortened; never the transcript.
//
// Scopes (user-level OAuth app): meeting:read:list_meetings, meeting:read:summary (classic:
// meeting:read). Credential: see oauth.ts; a Server-to-Server app works too, with `user` set
// to your email.
//
// One stream, `summaries`: your past meetings from the cursor day up to now, a page at a time.

export const zZoomConfig = z.object({
  /** Your Zoom account's email: the source key and the identity. */
  email: z.email().transform((e) => e.toLowerCase()),
  /** Whose meetings: 'me' for a user-level app; your email or user ID for Server-to-Server. */
  user: z.string().trim().min(1).default('me'),
  /** Meetings whose topic or overview matches one of these (case-insensitive) are left out. */
  skipPatterns: z.array(z.string()).default(['confidential', '\\bHR\\b', 'personal']),
});
export type ZoomConfig = z.infer<typeof zZoomConfig>;

const API = 'https://api.zoom.us/v2';
export const ZOOM: OAuthProvider = {
  name: 'zoom',
  tokenUrl: 'https://zoom.us/oauth/token',
  clientAuth: 'basic',
  accountCredentials: true,
  // Scopes are chosen in the app's settings on the Zoom Marketplace.
  authUrl: 'https://zoom.us/oauth/authorize',
};
const PAGE = 100;
/** Summaries fetched per sync page. */
const BATCH = 20;
const OVERVIEW_CHARS = 400;
const ITEM_CHARS = 200;
const MAX_STEPS = 8;
const MAX_TOPICS = 8;
/** Zoom error codes for "no such meeting" or "no summary". */
const NO_SUMMARY = new Set([3001, 3322, 3323, 3324, 404]);
/** Zoom error codes for a token without the needed scope. */
const SCOPE_ERRORS = new Set([4700, 4711, 124]);

interface ZoomMeeting {
  uuid: string;
  id: number;
  topic?: string;
  start_time?: string;
}
interface SummaryDetail {
  label?: string;
  summary?: string;
}
export interface ZoomSummary {
  meeting_uuid?: string;
  meeting_id?: number;
  meeting_topic?: string;
  meeting_start_time?: string;
  meeting_end_time?: string;
  summary_title?: string;
  summary_overview?: string;
  summary_details?: SummaryDetail[];
  next_steps?: string[];
  edited_summary?: { summary_details?: SummaryDetail[]; next_steps?: string[] };
  summary_doc_url?: string;
}

type Queued = { uuid: string; topic: string };
interface SummariesCursor {
  /** Meetings starting on or after this day (YYYY-MM-DD, UTC). */
  since: string;
  round?: { until: string; queue: Queued[]; page: string | null; listed: boolean };
}

/** A meeting UUID in a path: double-encoded when it starts with "/" or contains "//". */
export function uuidPath(uuid: string): string {
  const once = encodeURIComponent(uuid);
  return uuid.startsWith('/') || uuid.includes('//') ? encodeURIComponent(once) : once;
}

export function summaryRecord(config: ZoomConfig, s: ZoomSummary): RecordInput | null {
  const topic = (s.meeting_topic ?? s.summary_title ?? '').trim();
  const overview = oneLine(s.summary_overview ?? '');
  const skip = (t: string) => config.skipPatterns.some((p) => new RegExp(p, 'i').test(t));
  if (skip(topic) || skip(overview)) return null;
  const details = s.edited_summary?.summary_details ?? s.summary_details ?? [];
  const steps = (s.edited_summary?.next_steps ?? s.next_steps ?? [])
    .map((x) => clip(oneLine(x), ITEM_CHARS))
    .filter(Boolean);
  const topics = details
    .map((d) => clip(oneLine(d.label ?? ''), ITEM_CHARS))
    .filter((l) => l && !skip(l));
  if (!overview && !steps.length && !topics.length) return null;
  const start = s.meeting_start_time;
  if (!start || !s.meeting_uuid) return null;
  return {
    externalId: `${s.meeting_uuid}/summary`,
    kind: 'meeting_summary',
    eventTime: new Date(start).toISOString(),
    title: clip(`Meeting summary: ${topic || '(no topic)'}`, 300),
    ...(s.summary_doc_url ? { url: s.summary_doc_url } : {}),
    actor: config.email,
    ...(overview ? { summary: clip(overview, OVERVIEW_CHARS) } : {}),
    payload: {
      meetingId: s.meeting_id ?? null,
      topic,
      ...(topics.length ? { topics: topics.slice(0, MAX_TOPICS) } : {}),
      ...(steps.length ? { nextSteps: steps.slice(0, MAX_STEPS) } : {}),
      ...(s.meeting_end_time
        ? {
            minutes: Math.round((Date.parse(s.meeting_end_time) - Date.parse(start)) / 60_000),
          }
        : {}),
    },
  };
}

const codeOf = (e: HttpError) => {
  try {
    return Number((JSON.parse(e.body) as { code?: number }).code);
  } catch {
    return Number.NaN;
  }
};

async function fetchSummary(
  input: SyncInput<ZoomConfig>,
  token: string,
  uuid: string,
): Promise<ZoomSummary | null> {
  try {
    return await requestJson<ZoomSummary>(
      input,
      `${API}/meetings/${uuidPath(uuid)}/meeting_summary`,
      { token, allow: [404] },
    );
  } catch (e) {
    if (!(e instanceof HttpError)) throw e;
    const code = codeOf(e);
    if (SCOPE_ERRORS.has(code)) throw new ConnectorAuthError(`zoom: ${e.message}`);
    if (e.status === 400 && NO_SUMMARY.has(code)) return null;
    throw e;
  }
}

async function syncSummaries(input: SyncInput<ZoomConfig>): Promise<SyncPage> {
  const { config } = input;
  const c = (input.cursor as SummariesCursor | null) ?? { since: dayBefore(input.backfillFrom) };
  const token = await oauthToken(input, ZOOM);
  const round = c.round ?? {
    until: input.now.toISOString(),
    queue: [],
    page: null,
    listed: false,
  };

  // List the next page of meetings when the queue runs dry.
  if (!round.queue.length && (!round.listed || round.page)) {
    const q = new URLSearchParams({
      type: 'previous_meetings',
      page_size: String(PAGE),
      from: c.since,
      to: round.until.slice(0, 10),
    });
    if (round.page) q.set('next_page_token', round.page);
    const res = await requestJson<{ meetings?: ZoomMeeting[]; next_page_token?: string }>(
      input,
      `${API}/users/${encodeURIComponent(config.user)}/meetings?${q}`,
      { token },
    );
    const from = Date.parse(`${c.since}T00:00:00Z`);
    const until = Date.parse(round.until);
    const seen = new Set<string>();
    round.queue = (res?.meetings ?? [])
      .filter((m) => {
        const t = m.start_time ? Date.parse(m.start_time) : Number.NaN;
        if (!(t >= from && t <= until) || seen.has(m.uuid)) return false;
        seen.add(m.uuid);
        return true;
      })
      .map((m) => ({ uuid: m.uuid, topic: m.topic ?? '' }));
    round.page = res?.next_page_token || null;
    round.listed = true;
  }

  const batch = round.queue.slice(0, BATCH);
  const records: RecordInput[] = [];
  for (const m of batch) {
    const s = await fetchSummary(input, token, m.uuid);
    const r = s && summaryRecord(config, { ...s, meeting_uuid: s.meeting_uuid ?? m.uuid });
    if (r) records.push(r);
  }
  round.queue = round.queue.slice(batch.length);

  if (round.queue.length || round.page) {
    return { records, cursor: { since: c.since, round } as unknown as Cursor, more: true };
  }
  const today = round.until.slice(0, 10);
  const since = [dayBefore(today), c.since].sort().at(-1) as string;
  return { records, cursor: { since } as unknown as Cursor, more: false };
}

export const zoom = defineConnector<ZoomConfig>({
  describe: () => ({
    kind: 'zoom',
    displayName: 'Zoom',
    authTypes: ['oauth'],
    streams: [
      { key: 'summaries', description: 'AI Companion summaries of the meetings you hosted' },
    ],
    policy: { fullText: false },
    oauth: ZOOM,
  }),
  parseConfig: (raw) => zZoomConfig.parse(raw),
  sourceKey: (config) => `zoom:${config.email}`,
  configSchema: () => z.toJSONSchema(zZoomConfig, { io: 'input' }) as Record<string, unknown>,
  defaultIdentity: (config) => ({ accountKey: config.email, aliases: [] }),
  sync(input) {
    if (input.stream !== 'summaries') throw new Error(`zoom: unknown stream ${input.stream}`);
    return syncSummaries(input);
  },
});
