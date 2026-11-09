# Personal Activity & Knowledge Hub — Data Schema

**Status:** Draft
**Version:** 0.1
**Date:** 2026-11-08
**Companion to:** `spec.md` v0.3 (§12)

This is the logical PostgreSQL schema. It is written as SQL for readability. The implementation uses Drizzle (`pg`) and Drizzle Kit migrations (spec §16.2), so column names and types here are binding, but exact syntax is not.

---

## 0. Conventions

| Topic | Rule |
|---|---|
| IDs | `text` ULIDs (26 chars, time-sortable), generated in the app. No serial or auto-increment. |
| Time | Instants are `timestamptz` (stored as UTC). Calendar dates are `date`. A period's end is **exclusive** (`period_end_excl`). |
| Tenancy | Every tenant-owned table has `workspace_id text not null`. Indexes that serve user queries start with `workspace_id`. |
| Audit columns | `created_at timestamptz not null default now()`. Where rows change: `updated_at`. Tables marked **append-only** are never `UPDATE`d or `DELETE`d by the app; the app database role has no grant to do so. |
| Hashes | `sha256` hex in `text`. Content hashes cover normalized JSON (sorted keys, no volatile fields). |
| Secrets | Never stored in these tables. Columns named `*_ref` point to the secret store. Tokens and codes are stored **hashed** (`*_hash`). |
| JSON | `jsonb` only for source payloads and settings. Anything that's filtered or joined on gets a real column. |
| Enums | Postgres enums (listed in §2). Adding a value is a migration. |
| Deletion | Soft for user-facing objects (`archived_at`, `revoked_at`, `hidden_at`). Hard deletes only through the retention or deletion workflow, and audited (spec §4, §8.6). |

---

## 1. The record contract (every input tier)

Everything that enters the hub becomes a `record`: built-in connectors, webhooks, file imports, the agent bridge, and notes (spec §8.8). An input must supply:

| Field | Required | Notes |
|---|:-:|---|
| `source` | ✅ | Stable source key, e.g. `github:github.com`, `jira:acme.atlassian.net`, `slack:acme`, `note`, `webhook:<hook-id>` |
| `external_id` | ✅ | Unique within `source`, e.g. `acme/sdk#765`, `PROJ-9472/changelog/123`, a Slack `channel:ts`, or a note's own ULID |
| `kind` | ✅ | `record_kind` enum (§2) |
| `event_time` | ✅ | When it happened in the source (UTC) |
| `title` | ✅ | One line, ≤ 300 chars |
| `url` | ✅ for tiers 2–3 | Permalink to the item in the source (the validator requires it, spec §8.8) |
| `actor` | ✅ | The source identity that did it (`login`, `username`, `user_id`), resolved to a user through `identities` |
| `summary` | | ≤ 2,000 chars. For chat and email, this **replaces** the body (spec §8.6). |
| `payload` | | Source-specific JSON (numbers, states, links). Never holds secrets or full message bodies unless full text is enabled for the source. |
| `applicable_date` | | Only to override the default, which is `event_time` converted to the project's time zone |
| `project_hint` | | A hint for routing (§5); never trusted blindly |

The hub adds: `id`, `workspace_id`, `tier`, `connector_account_id`, `captured_at`, `content_hash`, the revision number, routing results and visibility.

**Idempotency:** `(workspace_id, source, external_id)` identifies a record. The same `content_hash` means no change; a different hash means a new revision (§6).

---

## 2. Enums

```sql
create type trust_domain      as enum ('work', 'personal');
create type member_role       as enum ('viewer', 'commenter', 'contributor', 'manager', 'owner');
create type visibility        as enum ('project', 'private', 'restricted');
create type invite_kind       as enum ('join', 'recovery');
create type device_status     as enum ('pending', 'approved', 'rejected', 'revoked');
create type input_tier        as enum ('builtin', 'webhook', 'email', 'file_import', 'agent', 'manual');
create type record_kind       as enum (
  'pull_request', 'review', 'commit', 'code_comment',
  'issue_created', 'issue_change', 'issue_comment',
  'page_edit', 'page_comment',
  'message', 'meeting', 'meeting_summary', 'email',
  'webhook_event', 'imported_log', 'note');
create type note_kind         as enum ('event', 'context', 'guidance', 'reminder');
create type routing_status    as enum ('auto', 'confirmed', 'needs_review');
create type routed_by         as enum ('hint', 'rule', 'agent', 'model', 'user', 'connector');
create type revision_kind     as enum ('created', 'content', 'metadata', 'deleted_at_source', 'redacted');
create type report_kind       as enum ('daily', 'weekly', 'biweekly', 'monthly', 'quarterly', 'yearly');
create type gen_path          as enum ('agent', 'direct', 'import');
create type change_reason     as enum ('factual', 'editorial', 'initial');
create type report_status     as enum ('current', 'stale', 'superseded', 'rejected');
create type ref_type          as enum ('record_revision', 'work_item', 'report_version', 'stat');
create type guidance_scope    as enum ('workspace', 'project', 'report_kind', 'report');
create type link_origin       as enum ('rule', 'ai', 'user');
create type reminder_state    as enum ('suggested', 'active', 'snoozed', 'completed', 'dismissed', 'cancelled');
create type sync_status       as enum ('ok', 'running', 'error', 'disabled');
```

---

## 3. Identity, sign-in and tenancy

The auth library (Better Auth, spec §11.5) owns the core `user`, `session` and `passkey` tables. Their names and columns follow the library's schema; the columns below are what the hub requires of them, plus the hub's own tables. The library also owns `accounts` (always empty: there's no password or social sign-in, but the library requires the table), `verifications`, `jwks` and the `oauth_*` tables for MCP OAuth. Their shape is the library's (`packages/db/src/schema/auth-library.ts`, ADR 0001 and 0002).

```sql
-- People who can sign in.
create table users (
  id               text primary key,
  display_name     text not null,
  email            text unique,                   -- reference only; not used for sign-in (spec §11.5)
  email_verified   boolean not null default false, -- required by the auth library; unused
  image            text,                          -- required by the auth library; unused
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  disabled_at      timestamptz
);

-- One workspace per trust domain installation (spec §3.1–3.2).
create table workspaces (
  id               text primary key,
  domain           trust_domain not null,
  name             text not null,
  owner_user_id    text not null references users(id),
  time_zone        text not null,                 -- IANA, e.g. 'America/New_York'
  week_start       smallint not null default 1,   -- 1 = Monday (ISO)
  biweekly_anchor  date not null default '2024-01-01',
  settings         jsonb not null default '{}',
  created_at       timestamptz not null default now()
);

create table projects (
  id                        text primary key,
  workspace_id              text not null references workspaces(id),
  slug                      text not null,
  name                      text not null,
  time_zone                 text,                 -- null = the workspace time zone
  default_note_visibility   visibility not null default 'private',
  require_device_approval   boolean not null default true,
  created_at                timestamptz not null default now(),
  archived_at               timestamptz,
  unique (workspace_id, slug)
);

-- Roles per project (spec §9.2). An owner row exists from the MVP.
create table project_members (
  workspace_id     text not null,
  project_id       text not null references projects(id),
  user_id          text not null references users(id),
  role             member_role not null,
  invited_by       text references users(id),
  joined_at        timestamptz not null default now(),
  left_at          timestamptz,
  primary key (project_id, user_id)
);
create index on project_members (workspace_id, user_id) where left_at is null;

-- Invite link + confirmation code (spec §11.5). Single-use; only registers a passkey.
create table invites (
  id               text primary key,
  workspace_id     text not null,
  project_id       text not null references projects(id),
  kind             invite_kind not null,
  role             member_role not null,          -- for 'recovery', the member's current role
  for_user_id      text references users(id),     -- set for 'recovery'
  display_name     text not null,
  token_hash       text not null unique,          -- the link token, hashed
  code_hash        text not null,                 -- the confirmation code, hashed
  failed_attempts  smallint not null default 0,   -- 5 → invalid
  created_by       text not null references users(id),
  created_at       timestamptz not null default now(),
  expires_at       timestamptz not null,          -- created_at + 24h
  used_at          timestamptz,
  used_by_user_id  text references users(id),
  revoked_at       timestamptz
);

-- Passkeys (library-owned) + the hub's approval state per device.
create table passkeys (
  id               text primary key,
  user_id          text not null references users(id),
  credential_id    text not null unique,
  public_key       text not null,
  counter          bigint not null default 0,
  device_label     text,
  device_type      text not null default 'singleDevice', -- library: 'singleDevice' | 'multiDevice'
  backed_up        boolean not null default false,       -- library: synced passkey
  transports       text,                                 -- library: comma-separated
  aaguid           text,                                 -- library: authenticator model
  status           device_status not null default 'pending',
  approved_by      text references users(id),
  approved_at      timestamptz,
  created_via_invite_id text references invites(id),
  created_at       timestamptz not null default now(),
  last_used_at     timestamptz,
  revoked_at       timestamptz
);

-- Sessions (library-owned): any hub instance can validate them (spec §11.4).
-- The library stores the raw token and has no option to hash it. Session cookies are
-- HMAC-signed with the server secret, so a database read alone can't forge one (ADR 0001).
create table sessions (
  id               text primary key,
  user_id          text not null references users(id),
  token            text not null unique,
  passkey_id       text references passkeys(id),  -- not populated yet; M7 (ADR 0001)
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  expires_at       timestamptz not null,
  last_seen_at     timestamptz,
  revoked_at       timestamptz,
  user_agent       text,
  ip_address       text                           -- raw for now; to be hashed in M7 (ADR 0001)
);

-- Personal access tokens and MCP OAuth tokens (spec §11.5).
create table access_tokens (
  id               text primary key,
  user_id          text not null references users(id),
  workspace_id     text not null references workspaces(id),
  kind             text not null check (kind in ('pat', 'oauth')),
  client_name      text,                          -- e.g. 'Claude Code', 'Codex'
  token_hash       text not null unique,
  scopes           text[] not null,               -- e.g. {'read', 'notes:write'}
  project_ids      text[],                        -- null = every project the user can access
  created_at       timestamptz not null default now(),
  expires_at       timestamptz,
  last_used_at     timestamptz,
  revoked_at       timestamptz
);
```

---

## 4. Sources and connectors

```sql
-- The user's accounts in each source, used to decide "is this mine?" (spec §8.3).
create table identities (
  id               text primary key,
  workspace_id     text not null references workspaces(id),
  user_id          text not null references users(id),
  source           text not null,                 -- e.g. 'github:github.com'
  account_key      text not null,                 -- e.g. 'octocat', 'U0123ABCDEF', 'jdoe'
  aliases          text[] not null default '{}',  -- commit author names and emails
  unique (workspace_id, source, account_key)
);

-- One connected account; the credentials live in the secret store.
create table connector_accounts (
  id               text primary key,
  workspace_id     text not null references workspaces(id),
  owner_user_id    text not null references users(id),     -- never shared (spec §9.2)
  source           text not null,
  display_name     text not null,
  auth_type        text not null check (auth_type in ('oauth', 'pat', 'app', 'webhook_secret', 'none')),
  secret_ref       text,                          -- pointer into the secret store
  scopes           text[] not null default '{}',
  config           jsonb not null default '{}',   -- owner filters, noise filters, skip lists (spec §8.5)
  status           sync_status not null default 'ok',
  created_at       timestamptz not null default now(),
  disconnected_at  timestamptz
);

-- Which projects a connector feeds, and how its records are shown there.
create table project_sources (
  project_id            text not null references projects(id),
  connector_account_id  text not null references connector_accounts(id),
  workspace_id          text not null,
  default_visibility    visibility not null default 'private',   -- spec §9.3
  added_by              text not null references users(id),
  added_at              timestamptz not null default now(),
  primary key (project_id, connector_account_id)
);

-- Incremental sync position per stream (e.g. 'events', 'search:merged', 'jql:watched').
create table sync_states (
  connector_account_id  text not null references connector_accounts(id),
  stream                text not null,
  workspace_id          text not null,
  cursor                jsonb,
  last_success_at       timestamptz,
  last_attempt_at       timestamptz,
  last_error            text,
  history_floor         timestamptz,           -- the source keeps nothing older (e.g. GitHub events ~90 days)
  primary key (connector_account_id, stream)
);

-- Project assignment rules: ordered and versioned (spec §8.4).
create table project_rules (
  id               text primary key,
  workspace_id     text not null references workspaces(id),
  project_id       text not null references projects(id),
  priority         integer not null,
  match            jsonb not null,               -- e.g. {"source":"github:*","repo":"acme/cli"}
  version          integer not null,
  active           boolean not null default true,
  created_by       text not null references users(id),
  created_at       timestamptz not null default now()
);
create index on project_rules (workspace_id, active, priority);
```

---

## 5. Evidence: records, revisions, notes (Layer 1)

`records` holds the **current state** of each item, for fast queries. `record_revisions` is the **append-only history** and the target of evidence references. Notes are records of kind `note`.

```sql
create table records (
  id                    text primary key,
  workspace_id          text not null references workspaces(id),
  source                text not null,
  external_id           text not null,
  kind                  record_kind not null,
  tier                  input_tier not null,
  connector_account_id  text references connector_accounts(id),
  -- people
  owner_user_id         text not null references users(id),   -- note author, or the connector owner
  actor_identity_id     text references identities(id),       -- who did it in the source
  is_mine               boolean not null,                     -- actor maps to owner_user_id
  -- time (spec §3.4)
  event_time            timestamptz not null,
  captured_at           timestamptz not null,
  entered_at            timestamptz,                          -- notes only
  applicable_date       date not null,
  -- routing (spec §3.6, §8.4)
  project_id            text references projects(id),         -- null = Inbox
  routing_status        routing_status not null,
  routed_by             routed_by not null,
  routing_confidence    real,
  note_kind             note_kind,                            -- notes only
  parent_record_id      text references records(id),          -- split notes, comment→note conversions
  -- access (spec §9.3)
  visibility            visibility not null,
  -- content (current revision, denormalized)
  current_revision_id   text not null,
  title                 text not null,
  url                   text,
  summary               text,
  search_tsv            tsvector generated always as
                          (to_tsvector('simple', coalesce(title,'') || ' ' || coalesce(summary,''))) stored,
  hidden_at             timestamptz,                          -- moderation (spec §9.2); still in the evidence
  hidden_by             text references users(id),
  unique (workspace_id, source, external_id)
);
create index on records (workspace_id, project_id, applicable_date);
create index on records (workspace_id, project_id) where routing_status = 'needs_review' or project_id is null;  -- the Inbox
create index on records (workspace_id, owner_user_id, applicable_date);
create index on records using gin (search_tsv);

-- Append-only. Every content or metadata change adds a row.
create table record_revisions (
  id               text primary key,
  record_id        text not null references records(id),
  workspace_id     text not null,
  revision_no      integer not null,
  kind             revision_kind not null,
  content_hash     text not null,
  title            text not null,
  summary          text,
  payload          jsonb not null default '{}',
  -- the metadata as of this revision (so old reports keep their meaning)
  project_id       text,
  applicable_date  date not null,
  visibility       visibility not null,
  note_kind        note_kind,
  changed_by       text references users(id),   -- null for connector syncs
  captured_at      timestamptz not null default now(),
  unique (record_id, revision_no)
);

-- Audience for visibility = 'restricted'.
create table record_audiences (
  record_id        text not null references records(id),
  user_id          text not null references users(id),
  workspace_id     text not null,
  primary key (record_id, user_id)
);

create table record_tags (
  record_id        text not null references records(id),
  tag              text not null,
  workspace_id     text not null,
  primary key (record_id, tag)
);

-- People mentioned in notes and records: for filtering and privacy, never profiling (spec §3.6).
create table record_people (
  record_id        text not null references records(id),
  workspace_id     text not null,
  identity_id      text references identities(id),
  person_label     text not null,              -- display name as written
  primary key (record_id, person_label)
);

-- Semantic search (pgvector). Rebuilt from revisions; derived, not evidence.
-- Added in M5, once the embedding model (and so the vector size) is chosen (ADR 0005).
create table record_embeddings (
  record_revision_id text primary key references record_revisions(id),
  workspace_id     text not null,
  model            text not null,
  embedding        vector(1024) not null       -- dimension follows the chosen embedding model
);
```

**Notes in this model:**
- The note's raw text is `record_revisions.payload->>'text'` in revision 1, and it is **never changed**. Editing a note adds a `content` revision. Re-routing a note (project, date, kind or visibility) adds a `metadata` revision (spec §3.6).
- Splitting a multi-project note creates child records (`parent_record_id`), one per project. The parent stays as written.
- Converting a comment to a note creates a note whose `parent_record_id` is the comment's target and whose payload has `from_comment_id` (spec §9.2).

---

## 6. Derived: work items and daily bundles (Layer 2)

```sql
create table work_items (
  id               text primary key,
  workspace_id     text not null references workspaces(id),
  project_id       text references projects(id),
  key              text,                       -- e.g. 'PROJ-9472' when anchored on an issue
  title            text not null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create table work_item_links (
  work_item_id     text not null references work_items(id),
  record_id        text not null references records(id),
  workspace_id     text not null,
  origin           link_origin not null,
  confidence       real,                       -- for 'ai'
  created_at       timestamptz not null default now(),
  primary key (work_item_id, record_id)
);

-- One bundle per project and date; rebuilt whenever its inputs change.
create table daily_bundles (
  id               text primary key,
  workspace_id     text not null,
  project_id       text not null references projects(id),
  date             date not null,
  content_hash     text not null,              -- over the sorted record revision IDs + coverage
  coverage         jsonb not null,             -- {connector: {status, synced_through, truncated_before}}
  built_at         timestamptz not null default now(),
  dirty_since      timestamptz,                -- set when an input changes; cleared on rebuild
  unique (project_id, date)
);

create table bundle_items (
  bundle_id          text not null references daily_bundles(id),
  record_revision_id text not null references record_revisions(id),
  workspace_id       text not null,
  primary key (bundle_id, record_revision_id)
);
```

A bundle covers **every** record of its project and date, regardless of visibility. Visibility is applied when a report's inputs are chosen for its audience (§7).

**How bundles are kept current** (docs/adr/0006):
- They're built by a system job (`withSystem`, the migration role), since no user can see every record. The hash covers the sorted current revision IDs of the day's non-hidden records plus the coverage.
- A trigger on `records` (`mark_bundles_dirty`, SECURITY DEFINER) sets `dirty_since` on the bundles of a record's old and new `(project_id, applicable_date)` whenever its day, project, current revision or hidden state changes. A day with records but no bundle counts as stale too.
- `coverage` is keyed by connector account: `{source, status, truncatedBefore?}`, with `status` one of `complete` (every stream synced past the end of the day, in the project's time zone), `pending`, `error` or `truncated` (a stream's history floor is after the day starts). It holds no sync timestamps, so a finished day's hash stops changing.
- The morning run rebuilds every day of the last 14 and every stale day before them; a rebuild that finds the same hash only clears `dirty_since`.

---

## 7. Reports and guidance (Layers 3–4)

```sql
-- One logical report = project (or workspace) × kind × period × audience.
create table reports (
  id               text primary key,
  workspace_id     text not null references workspaces(id),
  project_id       text references projects(id),        -- null = workspace aggregate (spec Flow E)
  kind             report_kind not null,
  period_start     date not null,
  period_end_excl  date not null,
  audience_key     text not null,                       -- sorted user IDs hashed, or 'project'
  current_version_id text,
  status           report_status not null default 'current',
  stale_since      timestamptz,
  created_at       timestamptz not null default now(),
  unique (workspace_id, project_id, kind, period_start, audience_key)
);

create table report_audience (
  report_id        text not null references reports(id),
  user_id          text not null references users(id),
  workspace_id     text not null,
  primary key (report_id, user_id)
);

-- Append-only.
create table report_versions (
  id               text primary key,
  report_id        text not null references reports(id),
  workspace_id     text not null,
  version_no       integer not null,
  body_md          text not null,
  path             gen_path not null,                   -- agent | direct | import (spec §16.1)
  model            text,
  template_version text not null,
  client           text,                                -- e.g. 'Claude Code'
  actor_user_id    text references users(id),
  input_hash       text not null,                       -- hash over every report_inputs row
  guidance_hash    text not null,
  change_reason    change_reason not null,
  change_summary   text,
  validation       jsonb not null,                      -- validator result (spec §5.8)
  created_at       timestamptz not null default now(),
  unique (report_id, version_no)
);

-- Exactly which inputs a version used.
create table report_inputs (
  report_version_id text not null references report_versions(id),
  workspace_id      text not null,
  input_type        text not null check (input_type in ('bundle', 'report_version', 'guidance_version')),
  input_id          text not null,
  input_hash        text not null,
  primary key (report_version_id, input_type, input_id)
);

-- Per-statement evidence (spec §5.8). `anchor` identifies the statement in body_md (e.g. a stable bullet ID).
create table evidence_refs (
  report_version_id text not null references report_versions(id),
  workspace_id      text not null,
  anchor            text not null,
  ref_type          ref_type not null,
  ref_id            text not null,
  primary key (report_version_id, anchor, ref_type, ref_id)
);

-- Deterministic numbers in a report (spec §5.8): the query and its result.
create table report_stats (
  id                text primary key,
  report_version_id text not null references report_versions(id),
  workspace_id      text not null,
  metric            text not null,              -- e.g. 'prs_merged'
  query             jsonb not null,
  value             jsonb not null
);

create table guidance (
  id               text primary key,
  workspace_id     text not null references workspaces(id),
  scope            guidance_scope not null,
  project_id       text references projects(id),
  report_kind      report_kind,
  report_id        text references reports(id),
  author_user_id   text not null references users(id),
  visibility       visibility not null default 'project',
  current_version_id text,
  archived_at      timestamptz
);

-- Append-only.
create table guidance_versions (
  id               text primary key,
  guidance_id      text not null references guidance(id),
  workspace_id     text not null,
  version_no       integer not null,
  text             text not null,
  content_hash     text not null,
  created_by       text not null references users(id),
  created_at       timestamptz not null default now(),
  unique (guidance_id, version_no)
);
```

**Staleness:** when a bundle's `content_hash` changes, or a guidance or input report gets a new version, a job compares each dependent report's `report_inputs.input_hash` with the current value. On a mismatch it sets `reports.status = 'stale'` and `stale_since`, and repeats for the next level up (daily → weekly → bi-weekly/monthly → quarterly → yearly).

**Audience filtering:** the inputs for a report are the bundle items whose revision is visible to **every** user in `report_audience`. The validator rejects a version citing anything else (spec §9.4).

---

## 8. Collaboration, reminders, sharing, audit

```sql
create table comments (
  id               text primary key,
  workspace_id     text not null,
  project_id       text not null references projects(id),
  target_type      text not null check (target_type in ('record', 'report_version')),
  target_id        text not null,
  anchor           text,                       -- statement anchor when on a report
  author_user_id   text not null references users(id),
  body             text not null,
  visibility       visibility not null default 'project',
  created_at       timestamptz not null default now(),
  edited_at        timestamptz,
  deleted_at       timestamptz,                -- by the author
  hidden_at        timestamptz,                -- by a Manager or Owner
  hidden_by        text references users(id),
  converted_note_id text references records(id)
);
create index on comments (workspace_id, target_type, target_id);

create table reminder_suggestions (
  id               text primary key,
  workspace_id     text not null,
  project_id       text not null references projects(id),
  title            text not null,
  reason           text not null,
  proposed_due     timestamptz,
  uncertainty      text,
  source_record_ids text[] not null,
  sensitive        boolean not null default false,
  status           text not null check (status in ('open', 'accepted', 'rejected', 'saved')),
  created_at       timestamptz not null default now(),
  resolved_by      text references users(id),
  resolved_at      timestamptz
);

create table reminders (
  id               text primary key,
  workspace_id     text not null,
  project_id       text not null references projects(id),
  suggestion_id    text references reminder_suggestions(id),
  title            text not null,
  description      text,
  state            reminder_state not null,
  assignee_user_id text references users(id),
  due_at           timestamptz,
  recurrence       text,                       -- RFC 5545 RRULE
  external_system  text,                       -- 'jira', 'google_tasks', 'google_calendar', …
  external_id      text,
  visibility       visibility not null default 'project',
  created_by       text not null references users(id),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

-- Append-only.
create table reminder_events (
  id               text primary key,
  reminder_id      text not null references reminders(id),
  workspace_id     text not null,
  from_state       reminder_state,
  to_state         reminder_state not null,
  actor_user_id    text references users(id),  -- null when synced back from the external tool
  note             text,
  created_at       timestamptz not null default now()
);

create table reminder_sources (
  reminder_id      text not null references reminders(id),
  record_id        text not null references records(id),
  workspace_id     text not null,
  primary key (reminder_id, record_id)
);

-- Read-only link to one report version (spec §9.5).
create table share_links (
  id                text primary key,
  workspace_id      text not null,
  report_version_id text not null references report_versions(id),
  token_hash        text not null unique,
  require_signin    boolean not null default false,
  created_by        text not null references users(id),
  created_at        timestamptz not null default now(),
  expires_at        timestamptz not null,
  revoked_at        timestamptz,
  view_count        integer not null default 0
);

create table exports (
  id                text primary key,
  workspace_id      text not null,
  report_version_id text references report_versions(id),
  destination       text not null,             -- 'confluence', 'slack', 'markdown', …
  external_url      text,
  created_by        text not null references users(id),
  created_at        timestamptz not null default now()
);

-- Append-only.
create table audit_events (
  id               text primary key,
  workspace_id     text not null,
  actor_user_id    text references users(id),
  actor_token_id   text references access_tokens(id),
  action           text not null,              -- e.g. 'invite.created', 'device.approved', 'role.changed', 'report.published'
  target_type      text not null,
  target_id        text not null,
  data             jsonb not null default '{}',  -- never secrets
  created_at       timestamptz not null default now()
);
create index on audit_events (workspace_id, created_at desc);
```

The job queue (pg-boss) creates and owns its own `pgboss` schema.

---

## 9. Row-level security

Two `NOLOGIN` group roles, both granted to the login role in `DATABASE_URL` (ADR 0005):

- `hub_app`: the service layer. No grants on library-owned auth tables, no `update` or `delete` on append-only tables, no `delete` on `records`.
- `hub_auth`: the auth library's pool and invite redemption, which run before a user is known. It reaches only the sign-in tables, plus reading and consuming `invites`, inserting `project_members` and reading `projects`.

The service layer sets the role and the acting user for each transaction (`withActor`, `packages/db/src/actor.ts`), so a pooled connection never carries one user's identity into the next request:

```sql
set local role hub_app;
select set_config('app.user_id', '<ULID>', true);
select set_config('app.workspace_id', '<ULID>', true);
```

Helpers:

```sql
create function app_uid() returns text language sql stable as
  $$ select current_setting('app.user_id', true) $$;

-- The caller's role in a project, or null.
create function app_role(p_project text) returns member_role
  language sql stable security definer set search_path = public as $$
  select role from project_members
  where project_id = p_project and user_id = app_uid() and left_at is null $$;
```

The helpers that read membership are `security definer` with a fixed `search_path`, so the `project_members` policy can ask "is the caller a member?" without recursing into itself. Their owner must bypass RLS, because every table is `force`d. That holds for the superuser in Docker and PGlite, but not on a managed Postgres (ADR 0005, M7). One helper, `app_record_visible`, holds the record read rule, and `records` and its child tables all use it. The full set is in `packages/db/drizzle/0001_rls.sql`.

Policies (summary; each table gets `enable row level security` plus `force row level security`):

| Table | Read (`select`) | Write |
|---|---|---|
| `workspaces` | The owner, and members of its projects | Insert: only as the owner. Update: the owner. |
| `users` | Yourself, and anyone who shares an active project with you | Insert: `hub_auth` only |
| `projects` | Caller is a member, or the workspace owner | Insert: the workspace owner. Update: role ≥ manager. |
| `project_members`, `invites` | Caller is a member (invites: role ≥ manager) | Role ≥ manager; owner rows only by an owner. The workspace owner may add the first members of a new project. A member may update their own row to set `left_at`, but never raise their role. |
| `records`, `record_revisions` | `workspace_id` matches **and** one of: `owner_user_id = app_uid()`; `visibility = 'project'` and caller is a member; `visibility = 'restricted'` and caller is a current member and in `record_audiences`. **Inbox** rows (`project_id is null`) are visible only to their owner. Revisions follow their record's **current** visibility, so making a note private hides its history too. | Insert: role ≥ contributor (connectors run as their owner). `records` updates go only through the service, which also writes a revision. Revisions are insert-only. |
| `comments` | As the target, plus the comment's own visibility | Insert: role ≥ commenter. Update or delete: the author. `hidden_*`: role ≥ manager. |
| `reports`, `report_versions`, `evidence_refs` | Caller is in `report_audience` | Insert: role ≥ contributor, and the validator has passed |
| `guidance`, `guidance_versions` | As `visibility` | Project scope: role ≥ manager. Report scope: role ≥ contributor. |
| `daily_bundles`, `bundle_items` | Bundles: members of the project. Items: only revisions of records the caller can see. | System job only (no `hub_app` write grants) |
| `connector_accounts`, `identities`, `access_tokens`, `passkeys`, `sessions` | **Owner user only** | Owner user only (approval of `passkeys.status`: role ≥ manager in a shared project) |
| `audit_events` | Workspace owner, plus project owners for their projects | Insert-only (service role) |
| `share_links` | Role ≥ manager | Role ≥ manager |

Unauthenticated access to a `share_links` URL goes through a service endpoint that returns only that report version's `body_md`. It never opens a database session as a user.

**In the MVP** there's one user, who owns every project. The same policies run anyway, so they're tested from day one (spec §16.2, rule 5). `packages/db/test/rls.test.ts` has one test per policy, and fails if any table lacks forced RLS or any policy goes untested.

---

## 10. Main queries and their indexes

| Query | Served by |
|---|---|
| A day's evidence for a project | `records (workspace_id, project_id, applicable_date)`, then `bundle_items` |
| Inbox | the partial index on `records` (unrouted or needs review) |
| Missing or stale days in a range | `daily_bundles (project_id, date)` + `dirty_since`, compared with the calendar |
| Full-text search | `records.search_tsv` (GIN) |
| Semantic search | `record_embeddings` (HNSW index on `embedding`) |
| Stale reports | `reports (workspace_id, status)` |
| A report's evidence chain | `evidence_refs` → `record_revisions` → `records.url` |
| Sync resume | `sync_states (connector_account_id, stream)` |

---

## 11. Prototype migration (spec Appendix A)

| Prototype data | Becomes |
|---|---|
| `~/worklog/daily/YYYY/*.md` (one file per day) | One `imported_log` record per day (`tier = 'file_import'`), plus a `daily` report version with `path = 'import'` and `change_reason = 'initial'` |
| `~/worklog/notes/**` | `note` records with `routed_by = 'user'`, applicable date = file date |
| `~/worklog/reviews/**` | Report versions with `path = 'import'` and their period from the front matter. The status is `stale` until regenerated with evidence references. |
| `~/worklog/raw/*.json` | Discarded (re-collected by the connectors where history allows) |
| `config.json` | `identities`, `connector_accounts.config` (owner and noise filters), `project_rules` |
| Confluence month pages | A Confluence import connector (`source = 'confluence:worklog'`) |
