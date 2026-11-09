# Personal Activity & Knowledge Hub — Service API and MCP Contracts

**Status:** Draft
**Version:** 0.1
**Date:** 2026-11-08
**Companion to:** `spec.md` v0.3, `schema.md` v0.1

The hub has **one service layer**. The REST API (used by the web UI, scripts and webhooks) and the MCP server (used by agents) are thin adapters over it. Each operation is defined once here, with its REST route and, where agents need it, its MCP tool. Payload types are written as TypeScript; in the code they are Zod schemas shared by the service, the REST routes, the MCP tools and the UI.

---

## 1. Conventions

| Topic | Rule |
|---|---|
| Base path | `/api/v1`, JSON over HTTPS (`localhost` in local mode) |
| Authentication | **UI:** a session cookie (HTTP-only, Secure, SameSite=Lax), and state-changing requests also need the header `X-Hub-Client: web` (CSRF guard). **Scripts and agents:** `Authorization: Bearer <token>` (personal access token or MCP OAuth token, `schema.md` §3). **Local mode:** a per-install token (spec §11.3). |
| Authorization | Checked in the service layer **and** enforced by row-level security (`schema.md` §9). An item the caller can't see returns **404**, never 403, so its existence isn't revealed. A visible item the caller's role can't change returns **403**. |
| IDs and time | IDs are ULID strings. Instants are ISO 8601 UTC (`2026-11-06T22:36:30Z`). Calendar dates are `YYYY-MM-DD` in the project's time zone. Periods are `{start, endExcl}`. |
| Pagination | Cursor-based: `?limit=50&cursor=…` → `{ items: [...], nextCursor: string \| null }`. The maximum `limit` is 200. |
| Creates | `POST` accepts an `Idempotency-Key` header. Repeating the key within 24 hours returns the first result. Required for `/ingest` and `/hooks`. |
| Updates | Versioned objects (rules, guidance, project settings) need `If-Match: <version>`. A mismatch returns **412**. |
| Errors | RFC 9457 `application/problem+json`: `{ type, title, status, detail, code, errors? }`. `code` values are stable (§11). |
| Rate limits | Per token or session. Exceeding one returns **429** with `Retry-After`. Sign-in and invite redemption have tighter limits. |
| Long work | Sync, rebuild and direct generation return **202** with `{ jobId }`. Poll `GET /jobs/{id}`. |
| Health | `GET /healthz` (process alive), `GET /readyz` (database and migrations OK). No authentication; no data. |

---

## 2. Shared types

```ts
type Id = string;            // ULID
type IsoDate = string;       // 'YYYY-MM-DD'
type Instant = string;       // ISO 8601 UTC

type Role = 'viewer' | 'commenter' | 'contributor' | 'manager' | 'owner';
type Visibility = 'project' | 'private' | 'restricted';
type NoteKind = 'event' | 'context' | 'guidance' | 'reminder';
type ReportKind = 'daily' | 'weekly' | 'biweekly' | 'monthly' | 'quarterly' | 'yearly';

// The record contract (schema.md §1): what every input tier submits.
interface RecordInput {
  externalId: string;
  kind: RecordKind;               // schema.md §2
  eventTime: Instant;
  title: string;                  // ≤ 300 chars
  url?: string;                   // required for webhook, email and agent tiers
  actor: string;                  // the source account, e.g. 'octocat'
  summary?: string;               // ≤ 2,000 chars
  payload?: Record<string, unknown>;
  applicableDate?: IsoDate;       // overrides event time → project time zone
  projectHint?: string;           // a project slug or a free-text hint; never trusted blindly
}

interface Routing {
  kind: NoteKind;
  projects: string[];             // project IDs or slugs; more than one means split
  date?: IsoDate;                 // for 'event'
  tags?: string[];
  people?: string[];
  visibility?: Visibility;
  audience?: Id[];                // for 'restricted'
  confidence: number;             // 0..1, from the router (agent or model)
}

interface RecordView {
  id: Id; revisionId: Id; revisionNo: number;
  source: string; externalId: string; kind: RecordKind; tier: InputTier;
  title: string; summary?: string; url?: string;
  eventTime: Instant; applicableDate: IsoDate; enteredAt?: Instant;
  projectId: Id | null; routingStatus: 'auto' | 'confirmed' | 'needs_review';
  noteKind?: NoteKind; tags: string[];
  owner: { id: Id; name: string }; isMine: boolean;
  visibility: Visibility; hidden: boolean;
  workItemIds: Id[];
}

interface Coverage {              // per connector, for a day or a period (spec §5.9)
  [connector: string]: { status: 'ok' | 'error' | 'partial' | 'not_run';
                         syncedThrough?: Instant; truncatedBefore?: Instant; via?: 'agent' };
}
```

---

## 3. Operations

Each row is one service operation. Minimum role is per project. "Owner user" means the person who owns the object (e.g. their own connector). **MCP** names the agent tool, if there is one.

### 3.1 Sign-in, account and tokens

| Operation | REST | Min. role | MCP |
|---|---|---|---|
| Start invite redemption (check token, then code) | `POST /auth/invites/redeem` `{token, code}` → WebAuthn registration options | — (public, rate-limited) | |
| Finish passkey registration | `POST /auth/passkeys/register` `{attestation}` → `{status: 'pending' \| 'approved'}` | — | |
| Passkey sign-in | `POST /auth/passkeys/challenge` → options; `POST /auth/passkeys/verify` `{assertion}` → session cookie | — | |
| Sign out | `POST /auth/logout` | signed in | |
| Who am I | `GET /me` → `{user, projects: [{id, name, role}]}` | signed in | |
| My sessions and devices | `GET /me/sessions`, `DELETE /me/sessions/{id}`, `GET /me/passkeys`, `DELETE /me/passkeys/{id}` | owner user | |
| Personal access tokens | `GET /me/tokens`, `POST /me/tokens` `{name, scopes, projectIds?, expiresAt?}` → `{token}` (**shown once**), `DELETE /me/tokens/{id}` | owner user | |
| MCP OAuth | `/.well-known/oauth-authorization-server`, `/oauth/authorize`, `/oauth/token`, `/oauth/register` (dynamic client registration), as in the MCP authorization spec | — | |

### 3.2 Projects, members, invites, devices

| Operation | REST | Min. role | MCP |
|---|---|---|---|
| List my projects | `GET /projects` | member | (in `get_status`) |
| Create project | `POST /projects` `{name, slug, timeZone?, defaultNoteVisibility?}` | workspace owner | |
| Read or update settings | `GET /projects/{p}`, `PATCH /projects/{p}` (`If-Match`) | viewer / manager | |
| Archive | `POST /projects/{p}/archive` | owner | |
| Members | `GET /projects/{p}/members` | viewer | |
| Change role | `PATCH /projects/{p}/members/{u}` `{role}` | manager (owner to change managers or owners) | |
| Remove member | `DELETE /projects/{p}/members/{u}` | manager (owner for managers) | |
| Leave | `POST /projects/{p}/leave` `{deleteMyNotes?: boolean}` | member (not the last owner) | |
| Create invite | `POST /projects/{p}/invites` `{displayName, role}` → `{link, code, expiresAt}` (**code shown once**) | manager | |
| Recovery invite | `POST /projects/{p}/members/{u}/recovery-invite` → `{link, code, expiresAt}` | manager | |
| List or revoke invites | `GET /projects/{p}/invites`, `DELETE /projects/{p}/invites/{id}` | manager | |
| Pending devices | `GET /projects/{p}/devices?status=pending` | manager | |
| Approve or reject a device | `POST /devices/{passkeyId}/approve`, `POST /devices/{passkeyId}/reject` | manager | |

### 3.2a Workspace

| Operation | REST | Min. role | MCP |
|---|---|---|---|
| Workspace settings | `GET /workspace` → `{id, name, domain, timeZone, weekStart, isOwner}`, `PATCH /workspace` `{name?, timeZone?, weekStart?}` | member / workspace owner | |
| Project settings | `PATCH /projects/{p}` `{name?, timeZone? (null: the workspace's), defaultNoteVisibility?}` | manager | |
| Archive a project | `POST /projects/{p}/archive` → 204 | owner | |

### 3.3 Notes, records, Inbox, search

| Operation | REST | Min. role | MCP |
|---|---|---|---|
| Add a note | `POST /notes` `{text, routing?, projectId?, visibility?}` → `{note: RecordView, routed: boolean, children?: RecordView[]}` | contributor (in the routed project); otherwise lands in the Inbox | `add_note` |
| Edit my note | `PATCH /notes/{id}` `{text}` → a new content revision | author | |
| Inbox | `GET /inbox` → notes and records that aren't confidently routed | owner user | `list_inbox` |
| Route or re-route | `POST /records/{id}/route` `Routing` → metadata revision(s); a split creates child notes | owner user, or manager for others' records | `route_note` |
| Change visibility | `POST /records/{id}/visibility` `{visibility, audience?}` | owner user | |
| Hide or unhide (moderation) | `POST /records/{id}/hide`, `POST /records/{id}/unhide` | manager | |
| Read a record | `GET /records/{id}` → `RecordView`; `GET /records/{id}/revisions` | visible to caller | resource `hub://record/{id}` |
| Search | `GET /search?q=&projectId=&from=&to=&mode=text\|semantic\|hybrid&kinds=` → `{items: (RecordView & {score})[]}` | visible to caller | `search` |
| Ingest (agent bridge, tier 3) | `POST /ingest` `{source, records: RecordInput[], projectId?}` → `{created, updated, unchanged, rejected: [{externalId, code}]}` | contributor | `ingest_records` |
| Webhook (tier 2) | `POST /hooks/{hookId}` with `X-Hub-Signature: sha256=…` (HMAC of the body) → 202 | hook secret | |
| File import | `POST /imports` (multipart: `.md`, `.csv`, `.ics`, `.json`) → `{jobId}` | contributor | |

`add_note` with `routing` from an agent: if `confidence` is at least the workspace threshold (default 0.8) and the caller is at least a contributor in every routed project, the note is filed with `routed_by = 'agent'`. Otherwise it goes to the Inbox, keeping the agent's routing as a suggestion.

### 3.4 Days, bundles, status, stats

| Operation | REST | Min. role | MCP |
|---|---|---|---|
| Days in a range | `GET /projects/{p}/days?from=&to=` → `[{date, recordCount, mineCount, bundleHash, dirty, daily: {reportId, status, versionId} \| null, coverage}]` | viewer | |
| One day | `GET /projects/{p}/days/{date}` → `{bundle, workItems: [{id, title, records: RecordView[]}], unlinked: RecordView[], daily: ReportVersionView \| null, coverage}` | viewer (records filtered by visibility) | `get_day` |
| Rebuild a day's bundle | `POST /projects/{p}/days/{date}/rebuild` → `{date, hash, changed, items}` | contributor | |
| Status | `GET /status?projectId=` → `{openIssues, prsInFlight, staleReports, missingDays, inboxCount, pendingSuggestions, pendingDevices, connectors: Coverage}` | viewer | `get_status` |
| Stats | `GET /stats?projectId=&from=&to=&metrics=` → `{metrics: [{metric, value, query}]}` (deterministic, spec §5.8) | viewer | `get_stats` |

### 3.5 Reports

| Operation | REST | Min. role | MCP |
|---|---|---|---|
| List | `GET /projects/{p}/reports?kind=&from=&to=&status=` | viewer (only reports whose audience includes the caller) | |
| Resolve (find or create the logical report) | `POST /projects/{p}/reports/resolve` `{kind, date, audience: 'me' \| 'project' \| Id[]}` → `{reportId, period, status, currentVersionId}` | contributor | (inside `get_report_inputs`) |
| Read | `GET /reports/{r}`, `GET /reports/{r}/versions`, `GET /report-versions/{v}` → `ReportVersionView` | in audience | `get_report`; resource `hub://report/{kind}/{period}` |
| Diff | `GET /report-versions/{v}/diff?against={v2}` → `{changeReason, changeSummary, added, removed, changedRefs, guidanceChanges}` | in audience | |
| Inputs for writing | `GET /reports/{r}/inputs` → `ReportInputs` (§4) | contributor, in audience | `get_report_inputs` |
| Save a version (agent path) | `POST /reports/{r}/versions` `ReportSubmission` → 201 `ReportVersionView`, or **422** with `validation` errors | contributor, in audience | `save_report` |
| Generate (direct path) | `POST /reports/{r}/generate` `{instructions?}` → 202 `{jobId}`; **409** `direct_generation_disabled` when there's no model key | contributor, in audience | |
| Regenerate stale reports | `POST /projects/{p}/reports/refresh` `{kinds?, from?, to?}` → 202 | contributor | |

### 3.6 Guidance, comments, reminders

| Operation | REST | Min. role | MCP |
|---|---|---|---|
| Guidance | `GET /guidance?projectId=&scope=`, `POST /guidance` `{scope, projectId?, reportKind?, reportId?, text, visibility?}`, `POST /guidance/{g}/versions` `{text}`, `POST /guidance/{g}/archive` | viewer / manager (project scope) / contributor (report scope) | `add_guidance` |
| Comments | `GET /comments?targetType=&targetId=`, `POST /comments` `{targetType, targetId, anchor?, body, visibility?}`, `PATCH /comments/{c}`, `DELETE /comments/{c}` | viewer / commenter / author | |
| Hide a comment | `POST /comments/{c}/hide` | manager | |
| Comment → note | `POST /comments/{c}/to-note` `{routing?}` → `RecordView` | contributor | |
| Reminder suggestions | `GET /reminder-suggestions?projectId=` | contributor | `list_suggestions` |
| Resolve a suggestion | `POST /reminder-suggestions/{s}/resolve` `{action: 'accept' \| 'reject' \| 'save', title?, dueAt?, assigneeId?, external?: {system, target}}` → `{reminder?}` | contributor | `resolve_suggestion` |
| Reminders | `GET /reminders?projectId=&state=`, `PATCH /reminders/{id}` `{state?, dueAt?, recurrence?, assigneeId?, note?}` | contributor | |

### 3.7 Sharing and publishing

| Operation | REST | Min. role | MCP |
|---|---|---|---|
| Create a share link | `POST /report-versions/{v}/share-links` `{expiresAt, requireSignin?}` → `{url}` | manager | |
| Revoke a link | `DELETE /share-links/{id}` | manager | |
| Open a shared report | `GET /s/{token}` → HTML of that one version only (no API data) | link holder | |
| Publish | `POST /report-versions/{v}/publish` `{destination, target, confirm: true}` → `{exportId, externalUrl}`; without `confirm: true` → **400** `confirmation_required` | manager | `publish` |

### 3.8 Connectors, identities, rules

Connectors and identities belong to the user who connected them and are never shared (spec §9.2). Credentials are write-only: accepted on connect or replace, never returned (`hasSecret` says one is stored); locally they live in the OS keychain.

| Operation | REST | Min. role | MCP |
|---|---|---|---|
| Connector kinds | `GET /connector-kinds` → `[{kind, displayName, authTypes, streams, policy, configSchema}]` (`configSchema`: JSON Schema of the config) | signed in | |
| List my connectors | `GET /connectors` → `ConnectorView[]`: status, projects, and per stream the last success, last error and history floor | owner user | (in `get_status`) |
| Connect (token) | `POST /connectors` `{kind, displayName?, config, secret?, projectIds, defaultVisibility?, backfillFrom?}` → `ConnectorView`. Maps the account's login as an identity. | owner user; contributor in each project | |
| Connect (OAuth) | `GET /connectors/oauth/{provider}/start` → redirect; `GET /connectors/oauth/{provider}/callback` | owner user | |
| Update | `PATCH /connectors/{c}` `{displayName?, config?, projectIds?}`. The source (e.g. the host) can't change. | owner user | |
| Replace the credential | `PUT /connectors/{c}/secret` `{secret}` → 204 | owner user | |
| Sync now | `POST /connectors/{c}/sync` `{streams?, backfillFrom?}` → 202 `{queued, alreadyRunning}` (one sync per account at a time); without the job queue, the `SyncResult` | owner user | |
| Disconnect | `DELETE /connectors/{c}` → 204. Deletes the credential; records stay. | owner user | |
| Webhooks | `POST /projects/{p}/hooks` `{name}` → `{url, secret}` (**secret shown once**), `DELETE /projects/{p}/hooks/{id}` | manager | |
| Identities | `GET /identities?source=`, `POST /identities` `{source, accountKey, aliases?}`, `DELETE /identities/{id}` | owner user | |
| Project rules | `GET /rules`, `POST /rules` `{projectId, priority?, match}`, `PUT /rules/{id}` (`If-Match: <version>`, 412 when stale), `DELETE /rules/{id}` (deactivates) | members read; manager or workspace owner write | |
| Rule preview | `POST /rules/preview` `{match}` → `{matches, total}`: the Inbox records it would move | signed in | |
| Apply rules | `POST /rules/apply` → `{routed, byProject}`: files matching Inbox records (`routed_by = 'rule'`) | owner of the records | |

`match` (spec §8.4): any of `source`, `repo` (GitHub), `project` (Jira), `space` (Confluence) as patterns with `*`, ignoring case; `kinds: RecordKind[]`; `titleContains`. All given conditions must hold; the lowest priority matching rule wins. Connector syncs apply rules to new records ahead of the account's own project.

### 3.9 Jobs and audit

| Operation | REST | Min. role |
|---|---|---|
| Morning run | `POST /runs/morning` → 202 `{queued, alreadyRunning}`: sync every connector, then rebuild bundles (spec §5.1). Also scheduled daily. | owner user |
| Job status | `GET /jobs/{id}` → `{state: 'queued' \| 'running' \| 'done' \| 'failed', progress?, result?, error?}` | the caller who started it |
| Audit log | `GET /audit?projectId=&from=&to=&action=` | workspace owner; project owners for their projects |

---

## 4. Writing a report: inputs, submission, validation

### 4.1 Inputs (`get_report_inputs` / `GET /reports/{r}/inputs`)

```ts
interface ReportInputs {
  report: { id: Id; kind: ReportKind; period: { start: IsoDate; endExcl: IsoDate };
            audience: { id: Id; name: string }[]; projectId: Id | null };
  template: { version: string; sections: string[]; instructions: string };
  guidance: { id: Id; versionId: Id; scope: string; text: string }[];   // most specific first
  // daily: the bundle, filtered to items visible to EVERY audience member
  bundles?: { date: IsoDate; hash: string; coverage: Coverage;
              workItems: { id: Id; title: string; records: RecordView[] }[];
              unlinked: RecordView[] }[];
  // weekly and up: the constituent reports (spec §5)
  inputReports?: { versionId: Id; kind: ReportKind; period: {...}; bodyMd: string; status: string }[];
  context?: RecordView[];          // the project's 'context' notes
  previous?: { versionId: Id; bodyMd: string };   // the last version, for continuity and plan vs. actual
  stats: { metric: string; value: unknown }[];    // deterministic numbers the report may cite
  gaps: { missingDays: IsoDate[]; staleInputs: Id[]; coverage: Coverage };
  refFormat: string;               // the citation syntax (§4.2), included so agents never guess
  inputHash: string;               // echoed back on submit
}
```

### 4.2 Citation syntax inside `bodyMd`

- **Record or note:** `[[r:<recordRevisionId>]]`
- **Work item:** `[[w:<workItemId>]]`
- **Statement in an input report:** `[[v:<reportVersionId>#<anchor>]]`
- **Number from stats:** `[[s:<metric>]]`, e.g. `Merged 68 PRs [[s:prs_merged]]`

Example:

```md
## SDK
- Fixed the expired code-signing secret that broke Windows and macOS CI [[w:01JC…]] [[r:01JB…]]
- Merged 18 SDK PRs [[s:prs_merged.sdk]]
```

The server assigns a stable **anchor** to every bullet and paragraph, stores the citations as `evidence_refs`, and renders them as links in the UI (the `[[…]]` tokens never reach readers).

### 4.3 Submission (`save_report` / `POST /reports/{r}/versions`)

```ts
interface ReportSubmission {
  bodyMd: string;
  inputHash: string;               // from ReportInputs; a mismatch → 409 stale_input
  changeSummary?: string;          // required when a previous version exists
  generator: { path: 'agent'; client: string; model?: string };
}
```

### 4.4 Validation (spec §5.8)

The version is stored only if every check passes. Otherwise **422** `validation_failed`, with `errors: ValidationError[]`:

| `code` | Meaning |
|---|---|
| `unreferenced_statement` | A bullet or paragraph has no citation (headings and the TL;DR summary line are exempt when every point in them is cited elsewhere) |
| `unknown_ref` | The citation points to nothing |
| `invisible_ref` | A cited item isn't visible to every audience member (spec §9.4) |
| `out_of_period` | A cited record's applicable date is outside the period |
| `number_without_stat` | A number that looks like a count or total has no `[[s:…]]` citation |
| `unknown_stat` | The cited metric isn't in `ReportInputs.stats` |
| `stale_input` | `inputHash` no longer matches the current inputs (returned as 409) |

```ts
interface ValidationError { code: string; anchor?: string; text?: string; ref?: string; hint: string }
```

Agents are expected to fix the errors and resubmit. The tool result includes `hint` text written for that purpose.

---

## 5. MCP server

- **Transport:** Streamable HTTP at `/mcp`, served by the hub process, plus a `hub-mcp` stdio proxy for clients that only launch stdio servers (spec §10.1).
- **Authentication:** OAuth 2.1 with PKCE (remote, hosted mode), or a personal access token (local mode and scripts). Every tool runs as the token's user, with that user's roles and visibility.
- **Tool annotations:** read tools have `readOnlyHint: true`. Write tools have `destructiveHint: false`, because nothing deletes or overwrites (notes append, reports add versions). `publish` is the only tool with external effects (`openWorldHint: true`), and it needs `confirm: true`.

### 5.1 Tools

| Tool | Input | Output | Service operation |
|---|---|---|---|
| `search` | `{query, projectId?, from?, to?, mode?, kinds?, limit?}` | `{items: (RecordView & {score})[]}` | §3.3 Search |
| `get_day` | `{date, projectId?}` | as `GET /projects/{p}/days/{date}` | §3.4 |
| `get_report` | `{kind, date, projectId?, audience?, versionId?}` | `ReportVersionView` with citations expanded to titles and URLs | §3.5 Read |
| `get_status` | `{projectId?}` | as `GET /status` plus `projects: [{id, name, role}]` | §3.4 |
| `get_stats` | `{from, to, projectId?, metrics?}` | as `GET /stats` | §3.4 |
| `add_note` | `{text, routing?, projectId?, visibility?}` | `{note, routed, children?, inbox?: boolean}` | §3.3 |
| `list_inbox` | `{limit?}` | `{items: RecordView[]}` (with suggested routing) | §3.3 |
| `route_note` | `{recordId, routing}` | `{records: RecordView[]}` | §3.3 |
| `add_guidance` | `{scope, text, projectId?, reportKind?, reportId?}` | `{guidanceId, versionId}` | §3.6 |
| `get_report_inputs` | `{kind, date, projectId?, audience?}` | `ReportInputs` (this resolves the report first) | §3.5 Resolve + Inputs |
| `save_report` | `{reportId, bodyMd, inputHash, changeSummary?, client, model?}` | `ReportVersionView`, or `{validation: ValidationError[]}` | §3.5 Save |
| `ingest_records` | `{source, records: RecordInput[], projectId?}` | `{created, updated, unchanged, rejected}` | §3.3 Ingest |
| `list_suggestions` | `{projectId?}` | `{items: ReminderSuggestion[]}` | §3.6 |
| `resolve_suggestion` | `{suggestionId, action, title?, dueAt?, assigneeId?, external?}` | `{reminder?}` | §3.6 |
| `publish` | `{reportVersionId, destination, target, confirm}` | `{externalUrl}` | §3.7 |

### 5.2 Resources

| URI | Content |
|---|---|
| `hub://day/{projectSlug}/{date}` | The day as Markdown, with citations expanded |
| `hub://report/{projectSlug}/{kind}/{period}` | The current version of the report for the caller's personal audience |
| `hub://record/{id}` | One record and its revisions |

### 5.3 Prompts (for agents that support MCP prompts)

| Prompt | Does |
|---|---|
| `morning_run` | `get_status` → for each missing or stale day: `get_report_inputs` → write → `save_report`, oldest first (spec §5.1) |
| `period_review` | `get_report_inputs` for a weekly, bi-weekly, monthly, quarterly or yearly report → write → `save_report` |
| `capture` | Turns a free-form message into one or more `add_note` calls with routing |

---

## 6. Webhooks and imports (tier 2)

- **Hook URL:** `POST /api/v1/hooks/{hookId}`. The body is a JSON object, or an array of `RecordInput`. A bare JSON object without the record fields is wrapped as one `webhook_event` record, with `title` from `title`/`summary`/`text` and `eventTime` = now.
- **Signature:** `X-Hub-Signature: sha256=<hex HMAC of the raw body with the hook secret>`. A missing or invalid signature returns 401. `X-Hub-Timestamp` older than 5 minutes is rejected (replay protection).
- **Limits:** 256 KB per request; 60 requests a minute per hook. Records land in the hook's project, or in the Inbox if a rule sends them elsewhere.
- **Imports:** `.md` (one note per file, or per `##` date section), `.csv` (mapped columns), `.ics` (meetings), `.json` (`RecordInput[]`).

---

## 7. Error codes

| HTTP | `code` | When |
|---|---|---|
| 400 | `bad_request`, `confirmation_required` | Malformed input; `publish` without `confirm: true` |
| 401 | `unauthenticated`, `invalid_signature` | No or bad session, token or webhook signature |
| 403 | `forbidden_role`, `device_pending` | Role too low; device not approved yet |
| 404 | `not_found` | Missing **or not visible** |
| 409 | `conflict`, `stale_input`, `direct_generation_disabled`, `already_used` | Duplicate, changed inputs, no model key, invite already used |
| 410 | `invite_expired`, `link_expired` | Expired invite or share link |
| 412 | `version_mismatch` | `If-Match` failed |
| 422 | `validation_failed`, `invite_code_invalid` | Report validation (§4.4), wrong confirmation code (attempts remaining in `detail`) |
| 429 | `rate_limited` | With `Retry-After` |
| 500 / 503 | `internal`, `unavailable` | Server-side; never includes secrets or stack traces |
