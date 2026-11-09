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
```

Inline hints in a note: `#project`, `@today` / `@yesterday` / `@YYYY-MM-DD`, `!event` / `!context` / `!guidance` / `!reminder`, and any other `!tag`. The raw text is stored as written; edits and re-routing add revisions (spec §3.6).

The same operations are on the REST API under `/api/v1` (`docs/api.md` §3.3), with `Authorization: Bearer $HUB_LOCAL_TOKEN`.

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
