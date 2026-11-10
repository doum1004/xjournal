import type { RecordInput } from '@xjournal/core';
import { z } from 'zod';
import { clip, dayBefore, oneLine } from './atlassian';
import { requestJson } from './http';
import { type OAuthProvider, oauthToken } from './oauth';
import { type Cursor, defineConnector, type SyncInput, type SyncPage } from './sdk';

// Google Calendar (spec §8.2, §8.7): the meetings you attended, from one calendar. Carries
// over the prototype's filters (spec Appendix A): a meeting has at least one other attendee
// and you didn't decline it; focus time, out of office, working location, all-day events and
// lunch or hold blocks are left out. Stores the title, time, who and a short, cleaned
// description (no join links, passcodes or dial-in numbers); never the invitation body.
//
// Scope: https://www.googleapis.com/auth/calendar.events.readonly (or calendar.readonly).
// Credential: see oauth.ts.
//
// One stream, `events`: past events from the cursor day up to now, then from yesterday on, so
// late edits to the day's events are picked up.

export const zGcalConfig = z.object({
  /** Your Google account's email: the source key and the identity. */
  account: z.email().transform((e) => e.toLowerCase()),
  calendarId: z.string().trim().min(1).default('primary'),
  /** Meetings need at least this many attendees besides you (rooms don't count). */
  minOthers: z.number().int().min(0).default(1),
  includeAllDay: z.boolean().default(false),
  /** Keep a cleaned, shortened description ("what about"). */
  includeDescription: z.boolean().default(true),
  /** Titles matching one of these (case-insensitive regexes) are not meetings. */
  ignoreTitles: z
    .array(z.string())
    .default([
      '^(lunch|hold|busy|block(ed)?|focus( time)?|ooo|out of office|commute|travel|dnd|do not book|no meetings?)\\b',
    ]),
});
export type GcalConfig = z.infer<typeof zGcalConfig>;

const API = 'https://www.googleapis.com/calendar/v3';
export const GOOGLE: OAuthProvider = {
  name: 'google',
  tokenUrl: 'https://oauth2.googleapis.com/token',
  clientAuth: 'body',
  authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
  scopes: ['https://www.googleapis.com/auth/calendar.events.readonly'],
  // A refresh token, and a new one even if this client was approved before.
  authParams: { access_type: 'offline', prompt: 'consent' },
};
const PAGE = 250;
const DESCRIPTION_CHARS = 240;
const MAX_NAMES = 8;

interface GcalAttendee {
  email?: string;
  displayName?: string;
  self?: boolean;
  resource?: boolean;
  organizer?: boolean;
  responseStatus?: 'needsAction' | 'declined' | 'tentative' | 'accepted';
}
export interface GcalEvent {
  id: string;
  status?: 'confirmed' | 'tentative' | 'cancelled';
  eventType?: string;
  htmlLink?: string;
  summary?: string;
  description?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
  attendees?: GcalAttendee[];
  organizer?: { email?: string; displayName?: string; self?: boolean };
  recurringEventId?: string;
}

interface EventsCursor {
  /** Events starting on or after this day (YYYY-MM-DD, UTC). */
  since: string;
  /** The round in progress: its end time and the next page. */
  round?: { until: string; pageToken: string };
}

/** A description without links, join details or HTML, on one line. */
export function cleanDescription(html: string): string {
  const text = html
    .replace(/<br\s*\/?>|<\/(p|div|li)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
  const kept = text
    .split('\n')
    .filter(
      (l) =>
        !/(join|passcode|password|pwd|meeting id|dial|one tap|zoom\.us|meet\.google|teams\.microsoft|webex|-::~)/i.test(
          l,
        ),
    )
    .join(' ')
    .replace(/https?:\/\/\S+/g, '');
  return oneLine(kept);
}

const nameOf = (a: GcalAttendee) =>
  a.displayName?.trim() || (a.email ?? '').split('@')[0] || 'someone';

export function eventRecord(config: GcalConfig, e: GcalEvent): RecordInput | null {
  if (e.status === 'cancelled') return null;
  if (e.eventType && e.eventType !== 'default') return null;
  const start = e.start?.dateTime;
  if (!start && !config.includeAllDay) return null;
  const title = (e.summary ?? '').trim();
  if (config.ignoreTitles.some((p) => new RegExp(p, 'i').test(title))) return null;

  const attendees = e.attendees ?? [];
  const self = attendees.find((a) => a.self);
  if (self?.responseStatus === 'declined') return null;
  const others = attendees.filter((a) => !a.self && !a.resource);
  if (others.length < config.minOthers) return null;

  const startIso = start ?? `${e.start?.date}T00:00:00.000Z`;
  const end = e.end?.dateTime;
  const minutes = end ? Math.round((Date.parse(end) - Date.parse(startIso)) / 60_000) : null;
  const description =
    config.includeDescription && e.description
      ? clip(cleanDescription(e.description), DESCRIPTION_CHARS)
      : '';
  return {
    externalId: `${config.calendarId}/${e.id}`,
    kind: 'meeting',
    eventTime: new Date(startIso).toISOString(),
    title: clip(title || '(no title)', 300),
    ...(e.htmlLink ? { url: e.htmlLink } : {}),
    actor: config.account,
    ...(description ? { summary: description } : {}),
    payload: {
      calendar: config.calendarId,
      ...(minutes != null ? { minutes } : {}),
      attendees: others.length,
      with: others.slice(0, MAX_NAMES).map(nameOf),
      ...(e.organizer?.email ? { organizer: e.organizer.email.toLowerCase() } : {}),
      ...(self?.responseStatus ? { response: self.responseStatus } : {}),
      ...(e.recurringEventId ? { recurring: true } : {}),
      ...(start ? {} : { allDay: true }),
    },
  };
}

async function syncEvents(input: SyncInput<GcalConfig>): Promise<SyncPage> {
  const { config } = input;
  const c = (input.cursor as EventsCursor | null) ?? { since: dayBefore(input.backfillFrom) };
  const until = c.round?.until ?? input.now.toISOString();
  const token = await oauthToken(input, GOOGLE);
  const q = new URLSearchParams({
    timeMin: `${c.since}T00:00:00Z`,
    timeMax: until,
    singleEvents: 'true',
    orderBy: 'startTime',
    maxResults: String(PAGE),
  });
  if (c.round?.pageToken) q.set('pageToken', c.round.pageToken);
  const url = `${API}/calendars/${encodeURIComponent(config.calendarId)}/events?${q}`;
  const res = await requestJson<{ items?: GcalEvent[]; nextPageToken?: string }>(input, url, {
    token,
  });
  const records = (res?.items ?? [])
    .filter((e) => {
      // Only meetings that have started: the window ends now, but be sure.
      const s = e.start?.dateTime ?? e.start?.date;
      return !s || Date.parse(s) <= Date.parse(until);
    })
    .map((e) => eventRecord(config, e))
    .filter((r): r is RecordInput => r !== null);

  if (res?.nextPageToken) {
    const cursor: EventsCursor = { since: c.since, round: { until, pageToken: res.nextPageToken } };
    return { records, cursor: cursor as unknown as Cursor, more: true };
  }
  const today = until.slice(0, 10);
  const since = [dayBefore(today), c.since].sort().at(-1) as string;
  return { records, cursor: { since } as unknown as Cursor, more: false };
}

export const gcal = defineConnector<GcalConfig>({
  describe: () => ({
    kind: 'gcal',
    displayName: 'Google Calendar',
    authTypes: ['oauth'],
    streams: [
      { key: 'events', description: 'Meetings you attended (not declined, not focus/OOO)' },
    ],
    policy: { fullText: false },
    oauth: GOOGLE,
  }),
  parseConfig: (raw) => zGcalConfig.parse(raw),
  sourceKey: (config) =>
    `gcal:${config.account}${config.calendarId === 'primary' ? '' : `/${config.calendarId}`}`,
  configSchema: () => z.toJSONSchema(zGcalConfig, { io: 'input' }) as Record<string, unknown>,
  defaultIdentity: (config) => ({ accountKey: config.account, aliases: [] }),
  sync(input) {
    if (input.stream !== 'events') throw new Error(`gcal: unknown stream ${input.stream}`);
    return syncEvents(input);
  },
});
