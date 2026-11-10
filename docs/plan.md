# Personal Activity & Knowledge Hub — Repository Layout and Delivery Plan

**Status:** Draft
**Version:** 0.1
**Date:** 2026-11-08
**Companion to:** `spec.md` v0.3, `schema.md` v0.1, `api.md` v0.1

---

## 1. Repository layout

A Bun-workspaces monorepo. One TypeScript codebase; the shared Zod schemas live in `packages/core` and are used by every app.

```
xjournal/
├── apps/
│   ├── server/        Hono app: REST /api/v1, MCP /mcp, auth routes, the static web build, pg-boss workers
│   ├── web/           React + Vite SPA (TanStack Router + Query, Tailwind, shadcn/ui)
│   ├── mcp-proxy/     `hub-mcp`: stdio ↔ Streamable HTTP proxy for stdio-only agent clients
│   └── cli/           `hub`: note, sync, migrate, backup, restore, invite, import
├── packages/
│   ├── core/          Domain types + Zod schemas, period and time-zone logic, citation parser, report validator
│   ├── db/            Drizzle schema, migrations, RLS policy SQL, repositories, PGlite test harness
│   ├── services/      The service layer: every operation in api.md §3, with authorization
│   ├── auth/          Better Auth config: passkeys, invites + codes, device approval, sessions, tokens, MCP OAuth
│   ├── connectors/    Connector SDK (api.md RecordInput) + built-ins: github, jira, confluence,
│   │                  slack, gcal, confluence-worklog-import, prototype-import
│   ├── reports/       Input assembly, templates, staleness propagation, direct-path generator (Anthropic SDK)
│   └── secrets/       Secret-store interface: OS keychain (local), managed vault (hosted)
├── infra/
│   ├── compose.yaml   postgres:17 + hub; `prod` profile adds Caddy (HTTPS) and backup jobs
│   ├── Dockerfile
│   └── backup/        Nightly pg_dump → off-machine storage; restore script
├── docs/              spec.md, schema.md, api.md, plan.md, ADRs
└── .github/workflows/ CI: typecheck, lint, unit + data-layer tests (PGlite), e2e (Playwright + Docker Postgres)
```

**Tooling:** TypeScript (strict), Biome (lint and format), `bun test` for unit and data-layer tests, Playwright for end-to-end tests.

**Dependency rule:**
- Apps depend on `services`. `services` depends on `db`, `core`, `connectors`, `reports`, `auth`.
- Nothing outside `db` imports Drizzle or writes SQL (spec §16.2).

**Where the code lives:** `https://github.com/doum1004/xjournal` (public). The code holds no data and no secrets.

---

## 2. Milestones

Each milestone ends with something you can **use**, not only something that's built. Sizes are relative: S ≈ a few days, M ≈ 1–2 weeks, L ≈ 2–4 weeks, for one developer working with agents.

### M0 — Foundations and spikes (S–M)

Goal: prove the risky parts before building on them.

- Repo skeleton, CI, `compose.yaml` with Postgres 17, `hub migrate`, `/healthz` and `/readyz`.
- Drizzle schema for the core tables (`schema.md` §3–5), the RLS helper functions and policies, and the PGlite test harness, with one RLS test per policy.
- **Spikes,** each with a short write-up (ADR):
  1. Better Auth: passkey registration through an invite link and code; device approval.
  2. MCP: Streamable HTTP server in Hono, plus the stdio proxy, connected from Claude Code. OAuth 2.1 flow in hosted mode.
  3. pg-boss and Drizzle on Bun. If either is incompatible, fall back to Node for the server.
  4. PGlite parity: the RLS and migration tests pass on both PGlite and Docker Postgres.

**Done when:** `docker compose up` and `bun run dev` start the hub; tests pass on PGlite in CI; every spike is either confirmed or replaced, with an ADR.

### M1 — Evidence store and your history (M)

- `records`, `record_revisions`, notes (`POST /notes`, `hub note "…"`), Inbox, full-text search.
- **Prototype import:** The daily logs, notes and reviews from `~/worklog` (`schema.md` §11), and the Confluence work-log import.
- Web UI v1: timeline (calendar heatmap), day view, record detail, quick-add note, search. Read-only for reports.

**Done when:** your existing history can be browsed and searched in the UI, and notes can be added from the CLI and the UI.

### M2 — Connectors and daily bundles (L)

- Connector SDK; GitHub (both hosts, owner and noise filters), Jira (Server/DC), Confluence page edits.
- `identities`, `sync_states` with a history floor, `connector_accounts` with secrets in the OS keychain.
- Project rules plus Inbox routing, with rule preview.
- Daily bundles with coverage and content hashes; the pg-boss morning sync with catch-up (spec §5.1).
- **Settings in the web UI**, so nothing needs the CLI:
  - Workspace: name, time zone, week start.
  - Projects: create, rename, time zone, default note visibility, archive.
  - Connectors: add an account (e.g. GitHub: host, login, owner and noise filters, token entered once and never shown again), see each stream's status, last sync, errors and history floor, sync now, edit filters, disconnect.
  - Identities: your logins, names and emails per source.
  - Project rules, with the preview.

**Done when:** the morning sync produces bundles at least as complete as the prototype's `collect` digest, for the same days, and workspaces, projects, connectors and identities can all be managed from the web UI.

### M3 — Reports and MCP: replaces the `worklog` skill (L)

- Report service: resolve, inputs (audience-filtered), citation parser, validator, versions, staleness propagation.
- Daily, weekly and monthly templates.
- MCP server: the `api.md` §5 tools, except `publish`, `list_suggestions` and `resolve_suggestion`; the `morning_run` and `period_review` prompts; the stdio proxy.
- Confluence work-log publisher, carrying over the prototype's edit-conflict guard.
- Agent bridge (`ingest_records`), so Slack, Calendar and Zoom data come in through Claude's connectors from day one.

**Done when:** a morning run from Claude Code writes validated, cited daily reports (and the weekly report on Mondays), mirrors them to Confluence, and the prototype skill is retired.

### M4 — Using the UI alone (M)

- Direct generation path (Claude API key from the secret store), the job queue, and the Generate button.
- Guidance UI, version history with diffs and factual/editorial labels, stale-report refresh, a gaps and coverage view, a stats panel.
- Markdown export.

**Done when:** a full week can be run from the UI without an agent.

### Phase 2 — Wider sources and longer periods (M5–M6)

- **M5:** built-in Slack (channel history, no search scope) and Google Calendar connectors (Zoom stays on the agent bridge); bi-weekly, quarterly and yearly reports; the career log.
- **M6:** work items with AI-suggested links; reminder suggestions delivered to Jira or Google Tasks; webhooks and file imports.

### Phase 3 — Family hub, shared (M7–M8)

- **M7:** Personal-domain deployment on one VM (Caddy, hub, Postgres, off-machine backups, monitoring) on its own cloud account. Invites with codes, passkeys and device approval; the members and roles UI; item visibility.
- **M8:** comments (and converting comments to notes), audience-aware reports (shared and personal), share links, protections for children's data (spec §9.7), each member's agent access through MCP OAuth.

---

### Status (2026-11-09)

| Milestone | State |
|---|---|
| M0 | Done (ADRs 0001–0005) |
| M1 | Done: 625 prototype days imported and browsable |
| M2 | Built (ADR 0006). GitHub verified against the prototype's digests on real accounts; Jira and Confluence tested against recorded API shapes, waiting for a real connection |
| M3 | Built (ADR 0007). The prototype's history imported as reports; a cited daily report written from real inputs over the API. Waiting on: a real morning run from Claude Code, and the Confluence mirror on the real work log |
| M4 | Built. Direct generation tested with a scripted model; waiting for a Claude API key to run for real |
| M5 | Built. Bi-weekly (from weekly reports, with plan vs. actual), quarterly and yearly reports; the career log (proposed by quarterly reports, approved and exported in the UI, `hub import career`); Slack and Google Calendar connectors, with OAuth sign-in from the CLI; tested against recorded API shapes, waiting for real connections. No Zoom connector: its API gives summaries to the host only, so Zoom summaries stay on the agent bridge |

## 3. Risks and how they're handled

| Risk | Handling |
|---|---|
| Better Auth's passkey or MCP OAuth support doesn't fit | M0 spike. Fallback: SimpleWebAuthn for passkeys, plus a minimal OAuth server for MCP |
| Bun incompatibility (pg-boss, drivers) | M0 spike. Fallback: run the server on Node; keep Bun for tooling |
| Agents produce reports that fail validation repeatedly | Validation errors include fix-it hints; `get_report_inputs` returns the citation syntax; measure first-pass validity in M3 |
| Citation requirement makes reports stilted | Template guidance plus summary-line exemptions (`api.md` §4.4); review with real weeks in M3 |
| GitHub's activity history is limited (~90 days) | `history_floor` in `sync_states`; older periods use search and the imported logs |
| Embedding model choice and cost | Text search only until M5; semantic search added once a model is chosen (the vector size follows it) |
| Work data policy (hosting, retention) | Local-only until approval; Slack and email store summaries and links only (spec §8.6) |
| Losing data on the single machine | Nightly off-machine `pg_dump`, and a quarterly restore test from M2 onward |

---

## 4. Decisions before M0 (resolved 2026-11-08)

1. **Repo:** `doum1004/xjournal` on github.com (public).
2. **Docs:** `spec.md`, `schema.md`, `api.md` and `plan.md` live in `docs/` of this repo.
3. **Prototype:** the `worklog` skill keeps running daily until M3 replaces it, so the history stays continuous. Its data is imported in M1 and topped up before the switch.
