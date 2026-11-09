# xjournal

A private activity and knowledge hub. It collects work activity (GitHub, Jira, Confluence, Slack, meetings) and personal notes, organizes them by project and date, and produces cited daily, weekly, monthly, quarterly and yearly reports. People use it through a web UI, and AI agents through MCP.

Status: M1 in progress (evidence store and your history). See [docs/plan.md](docs/plan.md) §2 and the [ADRs](docs/adr/).

## Quick start

Needs [Bun](https://bun.sh) 1.4 and Docker.

```sh
bun install
cp .env.example .env      # then set HUB_LOCAL_TOKEN and BETTER_AUTH_SECRET
bun run db:up             # Postgres 17 on 127.0.0.1:5432 (infra/compose.yaml)
bun run migrate           # hub migrate
bun run hub init          # once: your user and Work workspace (--name, --tz; default: this machine's zone)
bun run dev               # http://localhost:7420 — /healthz, /readyz, /api/v1, /mcp
```

## Notes from the command line

`bun run hub <command>` runs the service layer directly against `DATABASE_URL`, so the server doesn't need to be running.

```sh
bun run hub project add sdk "SDK work"            # projects: #sdk in notes
bun run hub note "Reviewed the release plan #sdk !decision"
bun run hub note "Fixed the flaky test @yesterday" # no project: goes to the Inbox
bun run hub inbox
bun run hub route <id> --project sdk               # or --date, --kind, --visibility, --project inbox
bun run hub search release --from 2026-11-01
bun run hub show <id>                              # a record and its revisions
bun run hub import worklog --project work --dry-run   # the prototype's ~/worklog daily logs
bun run hub import worklog --project work             # safe to repeat: unchanged days are skipped
bun run hub import confluence-worklog --from 2026-10-01 --to 2026-11-08 --project work  # CONFLUENCE_* in .env
```

Inline hints in a note: `#project`, `@today` / `@yesterday` / `@YYYY-MM-DD`, `!event` / `!context` / `!guidance` / `!reminder`, and any other `!tag`. The raw text is stored as written; edits and re-routing add revisions (spec §3.6).

The same operations are on the REST API under `/api/v1` (`docs/api.md` §3.3), with `Authorization: Bearer $HUB_LOCAL_TOKEN`.

## Connectors

Connector tokens go to the OS credential store (Windows Credential Manager, macOS Keychain, libsecret), never to `.env` or the database. `connector add` asks for the token without echoing it.

```sh
bun run hub connector kinds                        # what this hub can connect to
bun run hub connector add <kind> --project work --from 2026-01-01
bun run hub identity add github:github.com octocat --alias "Octo Cat"   # what counts as yours
bun run hub sync                                   # every connected account, from its cursor
bun run hub connectors                             # status, last sync and errors per stream
```

A sync writes each page of records together with its cursor, so an interrupted sync resumes where it stopped. Records go to the connector's project when it feeds exactly one, otherwise to the Inbox.

The same is in the web UI under **Settings**: connect, edit, re-token, sync, backfill or disconnect accounts, map identities, and manage the workspace and projects.

## The morning run

The hub server runs it every day at 07:00 in the workspace time zone (`HUB_MORNING_CRON` to change): every connector syncs from its cursor, then the daily bundles of the last 14 days, and of any older day whose records changed, are rebuilt. A bundle is a day's evidence for one project under one content hash, with each connector's coverage of that day (complete, pending, failed or truncated).

```sh
bun run hub run                  # the same run, from the CLI
bun run hub run --no-sync        # bundles only
bun run hub bundles --project work --date 2026-11-06   # one day
```

## Development

| Command | Does |
|---|---|
| `bun test` | All tests on in-memory PGlite (no Docker) |
| `bun run test:pg` | The same tests on the Docker Postgres (parity, ADR 0004) |
| `bun run typecheck` / `bun run lint` | TypeScript and Biome |
| `bun run db:generate <name>` | New Drizzle migration from `packages/db/src/schema` |

Connect Claude Code to a local hub: `claude mcp add --transport http xjournal http://localhost:7420/mcp --header "Authorization: Bearer $HUB_LOCAL_TOKEN"`, or use the stdio proxy (`apps/mcp-proxy`) as shown in ADR 0002.

| Document | Contents |
|---|---|
| [docs/spec.md](docs/spec.md) | Product specification |
| [docs/schema.md](docs/schema.md) | PostgreSQL schema, record contract, row-level security |
| [docs/api.md](docs/api.md) | Service API (REST) and MCP tools |
| [docs/plan.md](docs/plan.md) | Repository layout, milestones, risks |
