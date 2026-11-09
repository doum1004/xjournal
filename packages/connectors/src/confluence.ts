import type { RecordInput } from '@xjournal/core';
import { z } from 'zod';
import { AtlassianHttp, clip, dayBefore, hostOf, isoOf, zAtlassianBase } from './atlassian';
import { type Cursor, defineConnector, type SyncInput, type SyncPage } from './sdk';

// Confluence Server/Data Center page activity (spec §8.2): pages you created or edited and
// comments you wrote. Excludes your own work-log pages (the prototype's mirror). The work-log
// import itself is `confluence-worklog.ts`.
//
// CQL only reports a page's latest version, so several edits of one page between two syncs
// count once (as in the prototype).

export const zConfluenceConfig = zAtlassianBase.extend({
  /** Skip pages under these page IDs (e.g. the work-log tree). */
  excludeAncestorIds: z.array(z.string().trim()).default([]),
});
export type ConfluenceConfig = z.infer<typeof zConfluenceConfig>;

const PAGE = 50;

interface Content {
  id: string;
  type: string;
  title: string;
  space?: { key?: string };
  ancestors?: { id: string }[];
  version?: { number?: number; when?: string; by?: { username?: string; userKey?: string } };
  container?: { id?: string; title?: string; _links?: { webui?: string } };
  _links?: { webui?: string };
}

interface CqlCursor {
  since: string;
  start: number;
}

const STREAMS = {
  pages: {
    cql: (since: string) =>
      `contributor = currentUser() AND type = page AND lastmodified >= "${since}" ORDER BY lastmodified ASC`,
    expand: 'version,space,ancestors',
  },
  comments: {
    cql: (since: string) =>
      `creator = currentUser() AND type = comment AND created >= "${since}" ORDER BY created ASC`,
    expand: 'version,container,space',
  },
} as const;

export function contentRecord(config: ConfluenceConfig, c: Content): RecordInput | null {
  const v = c.version ?? {};
  if (!v.when) return null;
  const me = config.login.toLowerCase();
  const by = v.by?.username ?? v.by?.userKey ?? '';
  const space = c.space?.key;
  if (c.type === 'page') {
    // `contributor` matches anyone who ever edited it; only count it when the latest is yours.
    if (by.toLowerCase() !== me) return null;
    const ids = [c.id, ...(c.ancestors ?? []).map((a) => a.id)];
    if (ids.some((id) => config.excludeAncestorIds.includes(id))) return null;
    const n = v.number ?? 1;
    return {
      externalId: `page/${c.id}/v${n}`,
      kind: 'page_edit',
      eventTime: isoOf(v.when),
      title: clip(
        `${n === 1 ? 'Created' : 'Edited'} “${c.title}”${space ? ` [${space}]` : ''}`,
        300,
      ),
      url: `${config.baseUrl}${c._links?.webui ?? `/pages/viewpage.action?pageId=${c.id}`}`,
      actor: by,
      payload: { pageId: c.id, version: n, ...(space ? { space } : {}) },
    };
  }
  if (c.type === 'comment') {
    const on = c.container;
    if (on?.id && config.excludeAncestorIds.includes(on.id)) return null;
    return {
      externalId: `comment/${c.id}`,
      kind: 'page_comment',
      eventTime: isoOf(v.when),
      title: clip(`Commented on “${on?.title ?? c.title}”`, 300),
      url: `${config.baseUrl}${on?._links?.webui ?? c._links?.webui ?? ''}`,
      actor: by || config.login,
      payload: { ...(on?.id ? { pageId: on.id } : {}), ...(space ? { space } : {}) },
    };
  }
  return null;
}

async function syncCql(
  input: SyncInput<ConfluenceConfig>,
  stream: keyof typeof STREAMS,
): Promise<SyncPage> {
  const http = new AtlassianHttp(input);
  const c = (input.cursor as CqlCursor | null) ?? {
    since: dayBefore(input.backfillFrom),
    start: 0,
  };
  const s = STREAMS[stream];
  const q = new URLSearchParams({
    cql: s.cql(c.since),
    limit: String(PAGE),
    start: String(c.start),
    expand: s.expand,
  });
  const res = await http.request<{ results?: Content[]; size?: number }>(
    'GET',
    `/rest/api/content/search?${q}`,
  );
  const results = res.results ?? [];
  const records = results
    .map((r) => contentRecord(input.config, r))
    .filter((r): r is RecordInput => !!r);
  if (results.length === PAGE) {
    return {
      records,
      cursor: { since: c.since, start: c.start + PAGE } as unknown as Cursor,
      more: true,
    };
  }
  const today = input.now.toISOString().slice(0, 10);
  const since = [dayBefore(today), c.since].sort().at(-1) as string;
  return { records, cursor: { since, start: 0 } as unknown as Cursor, more: false };
}

export const confluence = defineConnector<ConfluenceConfig>({
  describe: () => ({
    kind: 'confluence',
    displayName: 'Confluence (Server/DC)',
    authTypes: ['pat'],
    streams: [
      { key: 'pages', description: 'Pages you created or edited' },
      { key: 'comments', description: 'Comments you wrote' },
    ],
    policy: { fullText: false },
  }),
  parseConfig: (raw) => zConfluenceConfig.parse(raw),
  sourceKey: (config) => `confluence:${hostOf(config.baseUrl)}`,
  configSchema: () => z.toJSONSchema(zConfluenceConfig, { io: 'input' }) as Record<string, unknown>,
  defaultIdentity: (config) => ({ accountKey: config.login, aliases: [] }),
  sync(input) {
    if (input.stream !== 'pages' && input.stream !== 'comments') {
      throw new Error(`confluence: unknown stream ${input.stream}`);
    }
    return syncCql(input, input.stream);
  },
});
