import { z } from 'zod';
import { type Connector, type Cursor, defineConnector, type SyncInput, type SyncPage } from './sdk';

// A scriptable connector for tests of the sync runner. Each stream is a function from the
// sync input to a page, so a test can page, fail, or echo the cursor and credential back.

const zFakeConfig = z.object({ host: z.string().default('fake.test') });
export type FakeConfig = z.infer<typeof zFakeConfig>;

export type FakeStream = (input: SyncInput<FakeConfig>) => SyncPage | Promise<SyncPage>;

export interface FakeConnector extends Connector<FakeConfig> {
  /** Every sync call, in order. */
  calls: { stream: string; cursor: Cursor; secret: string | null; backfillFrom: string }[];
}

export function fakeConnector(
  streams: Record<string, FakeStream>,
  opts: { kind?: string } = {},
): FakeConnector {
  const kind = opts.kind ?? 'fake';
  const calls: FakeConnector['calls'] = [];
  const c = defineConnector<FakeConfig>({
    describe: () => ({
      kind,
      displayName: 'Fake',
      authTypes: ['pat', 'none'],
      streams: Object.keys(streams).map((key) => ({ key, description: `fake ${key}` })),
      policy: { fullText: false },
    }),
    parseConfig: (raw) => zFakeConfig.parse(raw ?? {}),
    sourceKey: (config) => `${kind}:${config.host}`,
    async sync(input) {
      calls.push({
        stream: input.stream,
        cursor: input.cursor,
        secret: input.secret,
        backfillFrom: input.backfillFrom,
      });
      const fn = streams[input.stream];
      if (!fn) throw new Error(`fake: unknown stream ${input.stream}`);
      return fn(input);
    },
  });
  return Object.assign(c, { calls });
}

/** Pages through `items` `size` at a time; the cursor is the next offset. */
export function pagedStream(
  items: SyncPage['records'],
  size: number,
  extra: Partial<Pick<SyncPage, 'historyFloor'>> = {},
): FakeStream {
  return ({ cursor }) => {
    const from = typeof cursor === 'number' ? cursor : 0;
    const records = items.slice(from, from + size);
    const next = from + records.length;
    return { records, cursor: next, more: next < items.length, ...extra };
  };
}
