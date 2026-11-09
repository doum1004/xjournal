#!/usr/bin/env bun
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import {
  builtinConnectors,
  type ConfluenceConfig,
  scanConfluenceWorklog,
  scanWorklog,
  type WorklogRecord,
} from '@xjournal/connectors';
import type { RecordView } from '@xjournal/core';
import { connectPostgres, type DbHandle, migrate, migrationStatus } from '@xjournal/db';
import { osKeychain } from '@xjournal/secrets';
import * as svc from '@xjournal/services';

// `hub` CLI (plan.md §1). It runs the service layer in-process against DATABASE_URL, as the
// local owner, so it works whether or not the server is running.

const usage = `Usage: hub <command> [options]

Setup:
  migrate [--status]                 Apply pending migrations (or just report them)
  init [--name N] [--tz ZONE]        Create the local owner and Work workspace (once)

Projects:
  projects                           List projects
  project add <slug> <name> [--tz ZONE] [--visibility project|private]

Notes and records:
  note <text…>                       Add a note; reads stdin when no text is given.
                                     Hints: #project  @today|@yesterday|@YYYY-MM-DD
                                            !event|!context|!guidance|!reminder  !tag
  inbox                              Unrouted notes and records, newest first
  route <id> [--project SLUG|inbox] [--date D] [--kind K] [--visibility V]
  show <id>                          A record and its revisions
  search <query…> [--project SLUG] [--from D] [--to D] [--limit N]

Connectors:
  connectors                         Connected accounts and each stream's sync status
  connector kinds                    The connector kinds this hub knows
  connector add <kind> [--name N] [--project SLUG]… [--config JSON] [--from D]
                                     Connect an account. Asks for the token (hidden), or
                                     reads it from stdin; it goes to the OS keychain.
                                     --from: how far back the first sync reaches.
  connector remove <id>              Disconnect and delete the stored token (records stay)
  sync [ID…] [--stream S]… [--from D] [--max-pages N]
                                     Sync all connected accounts, or the ones given
  identities                         Your accounts in each source ("is this mine?")
  identity add <source> <login> [--alias A]…
                                     e.g. identity add github:github.com octocat
                                          --alias "Octo Cat" --alias octo@example.com
  identity remove <id>

Import:
  import worklog [DIR] --project SLUG|inbox [--dry-run]
                                     The prototype's daily logs (default DIR: ~/worklog).
                                     Safe to repeat: unchanged days are skipped, changed
                                     days get a new revision.
  import confluence-worklog --from D --to D --project SLUG|inbox [--dry-run]
                                     The Confluence work log's month pages ("November,
                                     2026"). Same records as the file import: one per day.

Environment:
  DATABASE_URL                       Postgres connection string
  CONFLUENCE_BASE_URL, CONFLUENCE_SPACE, CONFLUENCE_TOKEN [, CONFLUENCE_USER]
                                     For confluence-worklog. With CONFLUENCE_USER the token
                                     is sent as Basic auth, otherwise as a Bearer PAT.`;

type Handler = (h: DbHandle, args: string[]) => Promise<number>;

const describe = (records: WorklogRecord[], noun: string) => {
  const dates = records.map((r) => r.input.externalId).sort();
  return `${records.length} ${noun}${dates.length ? ` (${dates[0]} … ${dates.at(-1)})` : ''}`;
};

function confluenceConfig(): ConfluenceConfig | null {
  const e = process.env;
  const missing = ['CONFLUENCE_BASE_URL', 'CONFLUENCE_SPACE', 'CONFLUENCE_TOKEN'].filter(
    (k) => !e[k],
  );
  if (missing.length) {
    console.error(`Set ${missing.join(', ')} (in .env) to read the Confluence work log.`);
    return null;
  }
  return {
    baseUrl: e.CONFLUENCE_BASE_URL as string,
    spaceKey: e.CONFLUENCE_SPACE as string,
    token: e.CONFLUENCE_TOKEN as string,
    ...(e.CONFLUENCE_USER ? { user: e.CONFLUENCE_USER } : {}),
  };
}

/** Ingest in batches of 100 per source, printing rejected items. */
async function ingestAll(
  c: svc.Ctx,
  records: WorklogRecord[],
  tier: 'file_import' | 'builtin',
  projectId: string | null,
) {
  const total = { created: 0, updated: 0, unchanged: 0, rejected: 0 };
  const bySource = new Map<string, WorklogRecord[]>();
  for (const r of records) bySource.set(r.source, [...(bySource.get(r.source) ?? []), r]);
  for (const [source, items] of bySource) {
    for (let i = 0; i < items.length; i += 100) {
      const r = await svc.ingestRecords(c, {
        source,
        tier,
        projectId,
        records: items.slice(i, i + 100).map((d) => d.input),
      });
      total.created += r.created;
      total.updated += r.updated;
      total.unchanged += r.unchanged;
      total.rejected += r.rejected.length;
      for (const x of r.rejected) console.log(`  rejected ${x.externalId}: ${x.message}`);
    }
  }
  return total;
}

async function ctx(h: DbHandle): Promise<svc.Ctx> {
  return { db: h.db, actor: await svc.localOwner(h.db) };
}

async function projectIdFor(c: svc.Ctx, slug: string): Promise<string> {
  const p = (await svc.listProjects(c)).find((x) => x.slug === slug.toLowerCase());
  if (!p)
    throw new svc.ServiceError(404, 'not_found', `No project "${slug}". See \`hub projects\`.`);
  return p.id;
}

function line(r: RecordView, slugs: Map<string, string>): string {
  const where = r.projectId ? `#${slugs.get(r.projectId) ?? '?'}` : 'inbox';
  const tags = r.tags.length ? ` ${r.tags.map((t) => `!${t}`).join(' ')}` : '';
  return `${r.applicableDate}  ${where.padEnd(12)} ${r.title}${tags}  [${r.id}]`;
}

async function slugMap(c: svc.Ctx) {
  return new Map((await svc.listProjects(c)).map((p) => [p.id, p.slug]));
}

const connectorDeps = (): svc.ConnectorDeps => ({
  registry: builtinConnectors(),
  secrets: osKeychain(),
  log: {
    info: () => {},
    warn: (msg, data) => console.error(`  ${msg}${data ? ` ${JSON.stringify(data)}` : ''}`),
  },
});

/** Read a secret without echoing it: hidden from a terminal, or the whole of piped stdin. */
async function readSecret(label: string): Promise<string> {
  if (!process.stdin.isTTY) return readStdin();
  process.stdout.write(`${label}: `);
  const stdin = process.stdin;
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding('utf8');
  return new Promise((resolve, reject) => {
    let value = '';
    const done = (fn: () => void) => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.off('data', onData);
      process.stdout.write('\n');
      fn();
    };
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') return done(() => resolve(value.trim()));
        if (ch === '\u0003') return done(() => reject(new Error('Cancelled')));
        if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1);
        else value += ch;
      }
    };
    stdin.on('data', onData);
  });
}

const ago = (iso: string | null) => (iso ? iso.replace('T', ' ').slice(0, 16) : 'never');

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return '';
  return (await new Response(Bun.stdin.stream()).text()).trim();
}

const commands: Record<string, Handler> = {
  async connectors(h) {
    const c = await ctx(h);
    const slugs = await slugMap(c);
    const list = await svc.listConnectors(c);
    if (!list.length) {
      console.log('No connectors yet. Add one: hub connector add <kind>');
      return 0;
    }
    for (const a of list) {
      const where = a.projectIds.length
        ? a.projectIds.map((p) => `#${slugs.get(p) ?? '?'}`).join(' ')
        : 'inbox';
      console.log(`${a.displayName}  ${a.source}  → ${where}  [${a.status}]  ${a.id}`);
      for (const st of a.streams) {
        const floor = st.historyFloor ? `  history from ${st.historyFloor.slice(0, 10)}` : '';
        const err = st.lastError ? `  error: ${st.lastError}` : '';
        console.log(`  ${st.stream.padEnd(20)} last ok ${ago(st.lastSuccessAt)}${floor}${err}`);
      }
    }
    return 0;
  },

  async connector(h, args) {
    const [sub, ...rest] = args;
    const deps = connectorDeps();
    if (sub === 'kinds') {
      const kinds = deps.registry.list();
      if (!kinds.length) console.log('No connectors are built in yet.');
      for (const d of kinds) {
        const streams = d.streams.map((x) => x.key).join(', ');
        console.log(`${d.kind.padEnd(12)} ${d.displayName}  streams: ${streams}`);
      }
      return 0;
    }
    if (sub === 'add') {
      const { values, positionals } = parseArgs({
        args: rest,
        allowPositionals: true,
        options: {
          name: { type: 'string' },
          project: { type: 'string', multiple: true },
          config: { type: 'string' },
          from: { type: 'string' },
        },
      });
      const kind = positionals[0];
      const desc = kind ? deps.registry.get(kind)?.describe() : undefined;
      if (!kind || !desc) {
        const known =
          deps.registry
            .list()
            .map((d) => d.kind)
            .join(', ') || 'none yet';
        console.error(
          `Usage: hub connector add <kind> [--name N] [--project SLUG]… (kinds: ${known})`,
        );
        return 1;
      }
      const c = await ctx(h);
      const projectIds = await Promise.all((values.project ?? []).map((p) => projectIdFor(c, p)));
      let config: unknown = {};
      if (values.config) {
        try {
          config = JSON.parse(values.config);
        } catch {
          console.error('--config must be JSON');
          return 1;
        }
      }
      const secret = desc.authTypes.includes('none') ? '' : await readSecret('Token');
      const a = await svc.addConnector(c, deps, {
        kind,
        config,
        projectIds,
        ...(values.name ? { displayName: values.name } : {}),
        ...(values.from ? { backfillFrom: values.from } : {}),
        ...(secret ? { secret } : {}),
      });
      console.log(`Connected ${a.displayName} (${a.source})  ${a.id}`);
      console.log(`So its activity counts as yours: hub identity add ${a.source} <login>`);
      return 0;
    }
    if (sub === 'remove' && rest[0]) {
      await svc.removeConnector(await ctx(h), deps, rest[0]);
      console.log('Disconnected; the token was deleted from the keychain.');
      return 0;
    }
    console.error('Usage: hub connector kinds | add <kind> … | remove <id>');
    return 1;
  },

  async sync(h, args) {
    const { values, positionals } = parseArgs({
      args,
      allowPositionals: true,
      options: {
        stream: { type: 'string', multiple: true },
        from: { type: 'string' },
        'max-pages': { type: 'string' },
      },
    });
    const c = await ctx(h);
    const deps = connectorDeps();
    const ids = positionals.length ? positionals : (await svc.listConnectors(c)).map((a) => a.id);
    if (!ids.length) {
      console.log('No connectors to sync. Add one: hub connector add <kind>');
      return 0;
    }
    let failed = false;
    for (const id of ids) {
      const r = await svc.syncConnector(c, deps, id, {
        ...(values.stream ? { streams: values.stream } : {}),
        ...(values.from ? { backfillFrom: values.from } : {}),
        ...(values['max-pages'] ? { maxPages: Number(values['max-pages']) } : {}),
      });
      console.log(`${r.source}  [${r.status}]`);
      for (const w of r.warnings) console.log(`  ! ${w}`);
      for (const st of r.streams) {
        const counts = `${st.created} new, ${st.updated} updated, ${st.unchanged} unchanged`;
        const rej = st.rejected.length ? `, ${st.rejected.length} rejected` : '';
        const more = st.more ? ' (more to come: run sync again)' : '';
        const what = st.error ? `error: ${st.error}` : `${counts}${rej}${more}`;
        console.log(`  ${st.stream.padEnd(20)} ${what}`);
        for (const x of st.rejected.slice(0, 5)) {
          console.log(`    rejected ${x.externalId}: ${x.message}`);
        }
      }
      if (r.status === 'error') failed = true;
    }
    return failed ? 1 : 0;
  },

  async identities(h) {
    const list = await svc.listIdentities(await ctx(h));
    if (!list.length) console.log('No identities yet. Add one: hub identity add <source> <login>');
    for (const i of list) {
      const aliases = i.aliases.length ? `  (${i.aliases.join(', ')})` : '';
      console.log(`${i.source.padEnd(28)} ${i.accountKey}${aliases}  [${i.id}]`);
    }
    return 0;
  },

  async identity(h, args) {
    const [sub, ...rest] = args;
    if (sub === 'add') {
      const { values, positionals } = parseArgs({
        args: rest,
        allowPositionals: true,
        options: { alias: { type: 'string', multiple: true } },
      });
      const [source, accountKey] = positionals;
      if (!source || !accountKey) {
        console.error('Usage: hub identity add <source> <login> [--alias A]…');
        return 1;
      }
      const i = await svc.addIdentity(await ctx(h), {
        source,
        accountKey,
        aliases: values.alias ?? [],
      });
      console.log(`Mapped ${i.source} ${i.accountKey}  [${i.id}]`);
      return 0;
    }
    if (sub === 'remove' && rest[0]) {
      await svc.removeIdentity(await ctx(h), rest[0]);
      console.log('Removed.');
      return 0;
    }
    console.error('Usage: hub identity add <source> <login> [--alias A]… | remove <id>');
    return 1;
  },

  async migrate(h, args) {
    if (!args.includes('--status')) await migrate(h);
    const s = await migrationStatus(h);
    console.log(
      `migrations: ${s.applied}/${s.expected} applied${s.upToDate ? ' (up to date)' : ''}`,
    );
    return s.upToDate ? 0 : 1;
  },

  async init(h, args) {
    const { values } = parseArgs({
      args,
      options: { name: { type: 'string' }, tz: { type: 'string' } },
    });
    const { owner, created } = await svc.initLocal(h.db, {
      ...(values.name ? { name: values.name } : {}),
      ...(values.tz ? { timeZone: values.tz } : {}),
    });
    console.log(
      created
        ? `Created ${owner.displayName}'s Work workspace (${owner.timeZone}).`
        : `Already set up: ${owner.displayName}'s Work workspace (${owner.timeZone}).`,
    );
    return 0;
  },

  async projects(h) {
    const list = await svc.listProjects(await ctx(h));
    if (list.length === 0) console.log('No projects yet. Add one: hub project add <slug> <name>');
    for (const p of list) console.log(`${p.slug.padEnd(16)} ${p.name}  (${p.timeZone}, ${p.role})`);
    return 0;
  },

  async project(h, args) {
    const { values, positionals } = parseArgs({
      args,
      allowPositionals: true,
      options: { tz: { type: 'string' }, visibility: { type: 'string' } },
    });
    const [sub, slug, ...name] = positionals;
    if (sub !== 'add' || !slug || name.length === 0) {
      console.error('Usage: hub project add <slug> <name> [--tz ZONE] [--visibility V]');
      return 1;
    }
    const p = await svc.createProject(await ctx(h), {
      slug,
      name: name.join(' '),
      ...(values.tz ? { timeZone: values.tz } : {}),
      ...(values.visibility ? { defaultNoteVisibility: values.visibility } : {}),
    });
    console.log(`Created #${p.slug} (${p.timeZone}).`);
    return 0;
  },

  async note(h, args) {
    const text = args.join(' ').trim() || (await readStdin());
    if (!text) {
      console.error('Usage: hub note <text…>   (or pipe the text in)');
      return 1;
    }
    const c = await ctx(h);
    const { note, routed } = await svc.addNote(c, { text }, 'cli');
    console.log(`${routed ? 'Filed' : 'Inbox'}: ${line(note, await slugMap(c))}`);
    return 0;
  },

  async inbox(h) {
    const c = await ctx(h);
    const slugs = await slugMap(c);
    const page = await svc.listInbox(c, { limit: 200 });
    if (page.items.length === 0) console.log('Inbox is empty.');
    for (const r of page.items) console.log(line(r, slugs));
    if (page.nextCursor) console.log('… more in the UI or the API (GET /api/v1/inbox)');
    return 0;
  },

  async route(h, args) {
    const { values, positionals } = parseArgs({
      args,
      allowPositionals: true,
      options: {
        project: { type: 'string' },
        date: { type: 'string' },
        kind: { type: 'string' },
        visibility: { type: 'string' },
      },
    });
    const id = positionals[0];
    if (!id) {
      console.error(
        'Usage: hub route <id> [--project SLUG|inbox] [--date D] [--kind K] [--visibility V]',
      );
      return 1;
    }
    const c = await ctx(h);
    const projectId =
      values.project === undefined
        ? undefined
        : values.project === 'inbox'
          ? null
          : await projectIdFor(c, values.project);
    const r = await svc.routeRecord(c, id, {
      ...(projectId !== undefined ? { projectId } : {}),
      ...(values.date ? { date: values.date } : {}),
      ...(values.kind ? { kind: values.kind } : {}),
      ...(values.visibility ? { visibility: values.visibility } : {}),
    });
    console.log(`Routed: ${line(r, await slugMap(c))}`);
    return 0;
  },

  async show(h, args) {
    const id = args[0];
    if (!id) {
      console.error('Usage: hub show <id>');
      return 1;
    }
    const c = await ctx(h);
    const r = await svc.getRecord(c, id);
    console.log(line(r, await slugMap(c)));
    if (r.summary) console.log(`\n${r.summary}\n`);
    for (const rev of await svc.listRevisions(c, id)) {
      console.log(
        `  r${rev.revisionNo} ${rev.kind.padEnd(9)} ${rev.capturedAt}  ${rev.applicableDate}`,
      );
    }
    return 0;
  },

  async import(h, args) {
    const { values, positionals } = parseArgs({
      args,
      allowPositionals: true,
      options: {
        project: { type: 'string' },
        from: { type: 'string' },
        to: { type: 'string' },
        'dry-run': { type: 'boolean' },
      },
    });
    const [what, dirArg] = positionals;
    if (!values.project || (what !== 'worklog' && what !== 'confluence-worklog')) {
      console.error(
        'Usage: hub import worklog [DIR] --project SLUG|inbox [--dry-run]\n' +
          '       hub import confluence-worklog --from D --to D --project SLUG|inbox [--dry-run]',
      );
      return 1;
    }
    const c = await ctx(h);
    const projectId = values.project === 'inbox' ? null : await projectIdFor(c, values.project);
    const project = (await svc.listProjects(c)).find((p) => p.id === projectId);
    const timeZone = project?.timeZone ?? (await svc.localOwner(h.db)).timeZone;
    const where = project ? `#${project.slug}` : 'the Inbox';

    let records: WorklogRecord[];
    let tier: 'file_import' | 'builtin';
    if (what === 'worklog') {
      const dir = dirArg ?? join(homedir(), 'worklog');
      const scan = scanWorklog(dir, timeZone);
      records = scan.daily;
      tier = 'file_import';
      console.log(
        `${dir}: ${describe(records, 'daily logs')}, ${scan.reviews.length} reviews, ${scan.skipped.length} skipped`,
      );
      for (const s of scan.skipped) console.log(`  skipped ${s.file}: ${s.reason}`);
      if (scan.reviews.length) {
        console.log('  reviews become report versions once reports exist (M3); not imported now');
      }
    } else {
      if (!values.from || !values.to) {
        console.error('confluence-worklog needs --from and --to (YYYY-MM-DD)');
        return 1;
      }
      const cfg = confluenceConfig();
      if (!cfg) return 1;
      const scan = await scanConfluenceWorklog(cfg, { from: values.from, to: values.to }, timeZone);
      records = scan.records;
      tier = 'builtin';
      console.log(
        `Confluence: ${describe(records, 'days')} from ${scan.pagesRead.length} month pages` +
          (scan.pagesMissing.length ? `; no page for ${scan.pagesMissing.join(', ')}` : ''),
      );
    }
    if (values['dry-run']) return 0;

    const total = await ingestAll(c, records, tier, projectId);
    console.log(
      `Imported into ${where}: ${total.created} created, ${total.updated} updated, ` +
        `${total.unchanged} unchanged, ${total.rejected} rejected.`,
    );
    return total.rejected ? 1 : 0;
  },

  async search(h, args) {
    const { values, positionals } = parseArgs({
      args,
      allowPositionals: true,
      options: {
        project: { type: 'string' },
        from: { type: 'string' },
        to: { type: 'string' },
        limit: { type: 'string' },
      },
    });
    const c = await ctx(h);
    const page = await svc.search(c, {
      q: positionals.join(' '),
      ...(values.project ? { projectId: await projectIdFor(c, values.project) } : {}),
      ...(values.from ? { from: values.from } : {}),
      ...(values.to ? { to: values.to } : {}),
      limit: values.limit ?? '20',
    });
    const slugs = await slugMap(c);
    if (page.items.length === 0) console.log('No matches.');
    for (const r of page.items) console.log(line(r, slugs));
    return 0;
  },
};

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  const handler = command ? commands[command] : undefined;
  if (!handler) {
    console.log(usage);
    return command && command !== 'help' && command !== '--help' ? 1 : 0;
  }
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL is not set.');
    return 1;
  }
  const h = connectPostgres(url, { max: 2 });
  try {
    return await handler(h, rest);
  } catch (e) {
    if (e instanceof svc.ServiceError) {
      const details = e.errors?.map((x) => `  ${x.path || 'input'}: ${x.message}`).join('\n');
      console.error(`${e.message}${details ? `\n${details}` : ''}`);
      return 1;
    }
    throw e;
  } finally {
    await h.close();
  }
}

process.exit(await main(process.argv.slice(2)));
