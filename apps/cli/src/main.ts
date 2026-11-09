#!/usr/bin/env bun
import { parseArgs } from 'node:util';
import type { RecordView } from '@xjournal/core';
import { connectPostgres, type DbHandle, migrate, migrationStatus } from '@xjournal/db';
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

Environment:
  DATABASE_URL                       Postgres connection string`;

type Handler = (h: DbHandle, args: string[]) => Promise<number>;

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

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return '';
  return (await new Response(Bun.stdin.stream()).text()).trim();
}

const commands: Record<string, Handler> = {
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
