import type { RecordInput } from '@xjournal/core';

// The connector SDK (spec §8.1, §8.8 tier 5). A connector is plain code with no database
// access: given its config, credential and the stored cursor for one stream, it returns a
// page of records and the next cursor. The hub's sync runner (`@xjournal/services`) owns
// everything else: the secret store, cursors, identities, routing, dedup and status.

export type AuthType = 'oauth' | 'pat' | 'app' | 'webhook_secret' | 'none';

/** JSON that survives a round trip through `sync_states.cursor`. */
export type Cursor = null | boolean | number | string | Cursor[] | { [key: string]: Cursor };

export interface StreamDescription {
  /** Stable key, stored in `sync_states.stream`, e.g. 'events' or 'search:merged'. */
  key: string;
  description: string;
}

export interface ConnectorDescription {
  /** Stable key used in config and the CLI, e.g. 'github'. */
  kind: string;
  displayName: string;
  authTypes: AuthType[];
  streams: StreamDescription[];
  /** Policy constraints (spec §8.6). */
  policy: {
    /** Stores full message or page bodies (otherwise summary + permalink + metadata). */
    fullText: boolean;
    /** The source keeps no history older than this, e.g. GitHub events (~90 days). */
    historyLimitDays?: number;
  };
}

export interface SyncLog {
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
}

export interface SyncInput<C> {
  config: C;
  /** The credential from the secret store; `null` for auth type 'none'. */
  secret: string | null;
  stream: string;
  /** What this stream returned last time; `null` on the first sync (a backfill). */
  cursor: Cursor;
  /** The owner's identities in this source, for "is this mine?" filters (spec §8.3). */
  identities: { accountKey: string; aliases: string[] }[];
  /** Earliest day to fetch when there's no cursor yet (YYYY-MM-DD). */
  backfillFrom: string;
  now: Date;
  fetch: typeof fetch;
  log: SyncLog;
  signal?: AbortSignal;
}

export interface SyncPage {
  records: RecordInput[];
  /** Stored after this page's records are written, so a crash resumes from here. */
  cursor: Cursor;
  /** Another page is waiting; the runner calls `sync` again with `cursor`. */
  more: boolean;
  /** The source returned nothing older than this (spec §8.1 truncation). */
  historyFloor?: Date;
}

export interface Connector<C = unknown> {
  describe(): ConnectorDescription;
  /** Validate the account's `config` (owner and noise filters, hosts). Throws on bad input. */
  parseConfig(raw: unknown): C;
  /** The record `source` key for this account, e.g. 'github:github.com'. */
  sourceKey(config: C): string;
  sync(input: SyncInput<C>): Promise<SyncPage>;
  /** JSON Schema of the config, so a UI can build its form. */
  configSchema?(): Record<string, unknown>;
  /** The identity implied by the config (e.g. the GitHub login), mapped when connecting. */
  defaultIdentity?(config: C): { accountKey: string; aliases: string[] } | null;
}

export const defineConnector = <C>(c: Connector<C>): Connector<C> => c;

// biome-ignore lint/suspicious/noExplicitAny: a registry holds connectors of any config type.
export type AnyConnector = Connector<any>;

/** The connector kind of a source key: 'github:github.com' → 'github'. */
export const kindOfSource = (source: string) => source.split(':', 1)[0] ?? source;

/** The credential was refused (401/403): the user has to reconnect. */
export class ConnectorAuthError extends Error {
  override name = 'ConnectorAuthError';
}

/** The source asked us to slow down; the runner stops this stream and retries next sync. */
export class ConnectorRateLimitError extends Error {
  override name = 'ConnectorRateLimitError';
  constructor(
    message: string,
    readonly retryAt?: Date,
  ) {
    super(message);
  }
}

/** The connectors this hub knows, by kind. */
export class ConnectorRegistry {
  readonly #byKind = new Map<string, AnyConnector>();

  constructor(connectors: AnyConnector[] = []) {
    for (const c of connectors) this.register(c);
  }

  register(c: AnyConnector): this {
    const { kind } = c.describe();
    if (this.#byKind.has(kind)) throw new Error(`Connector already registered: ${kind}`);
    this.#byKind.set(kind, c);
    return this;
  }

  get(kind: string): AnyConnector | undefined {
    return this.#byKind.get(kind);
  }

  list(): ConnectorDescription[] {
    return [...this.#byKind.values()].map((c) => c.describe());
  }
}
