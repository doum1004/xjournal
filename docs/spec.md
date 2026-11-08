# Personal Activity & Knowledge Hub — Product Specification

**Status:** Draft
**Version:** 0.3 (stack and database decided)
**Date:** 2026-11-08
**Companion documents:** [`schema.md`](schema.md) (database), [`api.md`](api.md) (service API and MCP), [`plan.md`](plan.md) (repo layout and milestones)

**Changes from 0.1:**
- Added trust domains.
- Narrowed the MVP.
- Made the evidence store and report versioning concrete.
- Made traceability checkable.
- Added work items, identity mapping and retention rules.
- Reminders are delivered through external tools.
- Added agent access over MCP.
- Added a proposed technology stack.
- Fixed list formatting.

## 1. Overview

Build a private, extensible application. It collects activity and notes from multiple sources, organizes them by project and date, and produces traceable daily, weekly, bi-weekly, monthly, quarterly and yearly reports.

It runs locally first and can later be hosted, without redesign. It serves one person first. Nothing in the design should prevent other users from connecting their own accounts later, but multi-user features are not built until a second user exists.

The product is more than a reporting tool. It is a personal record of:
- what happened,
- what was accomplished,
- what needs follow-up,
- what the user chooses to share.

Both people and AI agents can read and update it.

## 2. Product goals

1. Create a reliable, searchable record of activities and decisions.
2. Combine automatically collected source data with user-written notes.
3. Generate useful reports at multiple time scales.
4. Preserve traceability: every report statement links to its evidence, and this is checked by a validator, not just intended (§5.8).
5. Let users steer or correct generated summaries without altering source records.
6. Keep work, personal projects and household/family information separated. Separation between trust domains is physical (§3.1), not only permission-based.
7. Detect possible follow-up actions and manage them through an explicit confirmation workflow.
8. Let AI agents (Claude Code, Codex, Claude Desktop) query and update the record through a defined interface (§10).
9. Support local-first and hosted deployment without redesigning the application.

### Non-goals (for now)

- Multi-tenant SaaS for strangers, organization-wide visibility and public (unauthenticated, permanent) sharing. Sharing projects with invited people (family, colleagues) **is** in scope (§9.2).
- Building a notification delivery system (§7.4).
- Replacing the source systems (Jira, GitHub, Confluence). The hub records and summarizes them; it does not manage work in them.

## 3. Core concepts and hierarchy

```
Trust domain (Work · Personal)          ← physical isolation boundary
 └── Workspace                          ← one per domain per user
      └── Project (SDK, CLI, Website · Side project A · Home · Family)
           ├── Sources & connector accounts
           ├── Source records & notes        (Layer 1)
           ├── Daily bundles                 (Layer 2)
           ├── Reports & versions            (Layer 3)
           ├── Guidance                      (Layer 4)
           └── Reminders
```

### 3.1 Trust domain

A trust domain is the outermost boundary. It decides **where data is stored, which credentials and AI model accounts are used, and which policies apply**.

| Domain | Contains | Storage and processing |
|---|---|---|
| **Work** | Employer source data: repos, Jira, Confluence, Slack, work calendar and meetings | Employer-approved locations only: the work laptop, employer cloud or repos, and the employer's AI account (e.g. Claude Enterprise). |
| **Personal** | Side projects, home, family, health and finance notes | Personal devices and accounts only. Never on employer infrastructure or employer AI accounts. |

Rules:
- Each domain has its **own database, file store, credential store and model account**. A single installation may host several domains, but they never share a database file, backup or AI prompt.
- **No aggregation across domains.** Cross-project views (§3.3, Flow E) work within one domain.
- The one sanctioned flow out of Work is the **career log** (§9.8). It contains only public-safe text that the user has reviewed, and it is exported by the user, never synced automatically.

### 3.2 Workspace

A workspace is the container for one user's information within one trust domain. It holds projects, settings (time zone, week start, bi-weekly anchor), identities (§8.3) and workspace-level guidance.

### 3.3 Project

A project is an independent context with its own:
- sources and connector assignments,
- source records and user notes,
- summary instructions and preferences,
- daily bundles and period reports,
- reminders and follow-up items,
- visibility settings.

A user may view one project or request an aggregate view across the projects they are authorized to see, within the same domain.

One source can feed several projects. For example, one Jira project can be split into SDK, CLI and Website by component, label or repo. **Project assignment rules** decide where each record goes (§8.4).

### 3.4 Source records

A source record is an item collected or entered into the system. Examples:
- Git commits, pull requests, reviews and comments
- Jira issues, comments and status changes
- Confluence page edits and comments
- Slack messages the user sent (summaries and links; see §8.6)
- Calendar events and meeting details, including Zoom AI meeting summaries where available
- Email threads (later)
- Manually entered notes
- Household maintenance, family activity and appointment notes (Personal domain)

Each record keeps its origin and four kinds of time:

| Field | Meaning |
|---|---|
| **Event time** | When the activity happened in the source |
| **Captured time** | When the application collected it |
| **Entered time** | When a user manually added it (notes only) |
| **Applicable date** | The calendar date the record counts toward, in the project time zone |

A note entered a week late can therefore count toward the earlier day without pretending it was captured then.

### 3.5 Work items

The same piece of work often appears in several sources: a Jira issue, two PRs, a Slack thread and a meeting. A **work item** groups related records so reports describe the work once, with all its evidence.

- Records are linked to a work item by deterministic rules first: Jira keys in PR titles, branch names or commit messages; PR links in Slack messages. Fuzzy matching comes second.
- AI-proposed links are stored as suggestions with a confidence score. Reports may use them, but they are visibly marked.
- Work items are derived data. They can be rebuilt, and they never modify records.

### 3.6 Notes: capture and routing

**Principle:** writing a note takes one step; deciding where it belongs is automated and always reversible.

**Capture.**
- **Channels:** UI quick-add (global shortcut), CLI `hub note "…"`, MCP `add_note` from any agent conversation; later email-in and a mobile shortcut.
- **The raw text is stored immediately and never edited** (entered time, author, channel) before any routing happens.
- **Optional inline hints** override everything else: `#project`, `@date` (`@yesterday`, `@2026-11-05`), `!kind` / `!tag` (e.g. `!meeting`, `!decision`).

**Routing** decides five things for each note:

| Decision | Values |
|---|---|
| **Kind** | `event` (evidence for a date), `context` (standing project background, no date), `guidance` (becomes a Layer 4 instruction), `reminder` (also creates a reminder suggestion, §7) |
| **Project(s)** | One or more. A note covering several projects can be split into linked parts. |
| **Applicable date** | For `event` notes, resolved from relative phrases; otherwise the date entered |
| **Tags** | meeting, decision, win, blocker, learning, people, … |
| **People mentioned** | Linked to the identity map where possible; used only for filtering and privacy |

**Routing order:**
1. **Inline hints.**
2. **Project rules** (§8.4): Jira keys, repo names, keywords.
3. **AI classification:**
   - **agent path:** the agent calling `add_note` passes its routing decision, with a confidence;
   - **direct path:** the hub classifies with its model key (§16.1);
   - **no model available:** rules only.
4. **Confidence threshold:** above it, the note is filed automatically, visibly, and can be undone. Below it, or when no project matched, the note goes to the **Inbox** for one-click sorting.

**Corrections.**
- Changing a note's project, date or kind is a **metadata revision**: the text is untouched, the history is kept, and the affected bundles and reports become stale.
- The UI offers to turn a correction into a project rule, so the Inbox shrinks over time.

**Privacy.**
- **Notes about other people** (`people` tag) are private by default, excluded from shareable reports unless approved line by line, and never used to profile anyone.
- **Notes meant for other people** (handoffs, FYIs) are shared the same way as reports (§9.5): reviewed, then published or shared. The hub is not a messaging system.
- **Crossing domains:** a note in the Work domain that looks personal (health, family, finances) prompts a suggestion to record it in the Personal domain instead. Notes never move between domains automatically (§3.1).

## 4. Information layers

There are four logical layers. They are separate responsibilities, not necessarily separate files or databases.

### Layer 1 — Source records and user notes (evidence)

This layer is the source of truth.

- **Append-only.** Records are inserted with a stable ID (`source + external_id`). When a source item changes (a PR is retitled, an issue moves status), a new **revision** row is added with a content hash and captured time. Earlier revisions are never overwritten.
- **Idempotent ingestion.** Re-collecting the same item with the same content hash is a no-op.
- **Backfill and late sources.** When a connector finds older history, or a new repository is added, the new records are inserted and the affected dates are marked stale (Flow B).
- **Deletion** is an explicit, audited action (retention policy or user request). It is never a side effect of a sync.

### Layer 2 — Daily evidence bundle

For each project and applicable date, the system assembles the relevant Layer 1 records into a normalized bundle. The bundle:
- groups records by work item (§3.5) and by source,
- includes notes added later for that date,
- links back to each record ID and revision,
- records **coverage**: which connectors ran, which failed, and which were truncated (e.g. API history limits).

A bundle is derived. It is rebuilt whenever its inputs change, and it has a **content hash** that reports use to detect staleness.

### Layer 3 — Generated reports

Report types: daily, weekly, bi-weekly, monthly, quarterly and yearly.

Reports are **versioned and append-only**. Each version records:
- the scope (project or workspace) and an explicit date range, with the start inclusive and the end exclusive,
- the exact inputs: bundle hashes or input-report version IDs,
- the guidance applied (the IDs and hashes of the instructions),
- the generator: model ID, prompt template version, and the agent or user that triggered it,
- a change explanation compared with the previous version, classified as **factual** (new or changed evidence) or **editorial** (guidance, rewrite or model change),
- the evidence references for every statement (§5.8).

A report is **stale** when any recorded input hash no longer matches the current input. Stale reports are flagged, never silently regenerated, unless automation is configured for that project.

Reports can be exported as Markdown with front matter (scope, range, inputs, guidance and generator), so the record stays portable and readable without the app.

### Layer 4 — User guidance and editorial feedback

Instructions that shape reports without changing evidence. Examples:
- "Do not include routine status meetings."
- "Emphasize implementation and technical decisions."
- "Do not mention this personal detail in the shareable report."
- "Use concise, factual language."
- "Do not infer that a task was completed unless a source supports it."

Guidance has a scope: workspace, project, report type or a single report. The more specific scope wins. Guidance is versioned. Changing it marks the affected reports stale for an **editorial** reason and never modifies Layer 1.

## 5. Reporting and aggregation rules

Default derivation:

| Report | Built from | Determines membership |
|---|---|---|
| Daily | Daily bundle + guidance | Applicable date of the records |
| Weekly | Daily reports of the week | The daily reports |
| Bi-weekly | The 2 weekly reports if aligned with the bi-weekly anchor; otherwise the daily reports for the exact range | Weekly or daily reports |
| Monthly | Daily reports of the calendar month (weekly reports optional, as context only) | Daily reports |
| Quarterly | The 3 monthly reports | Monthly reports |
| Yearly | The 12 monthly reports | Monthly reports |

Lower-level reports may be used to enrich or check a higher-level report. They must never change which dates belong to it.

### 5.1 Daily

Built from the project's daily bundle plus the applicable guidance. A late note, a new source, or a guidance change produces a new version.

**Timing.** By default a daily report is generated **the morning after** the day, once the day's activity is complete. A "today" draft can be produced on request and is marked partial. On each run, the system **catches up**: it generates a report for every weekday in the last N days (default 14) that has evidence but no current report, oldest first.

### 5.2 Weekly

Built from the daily reports in the week (Monday to Sunday by default). The exact daily report versions used are recorded. If any of them changes, the weekly report is marked stale.

### 5.3 Bi-weekly

Built from the two constituent weekly reports when the period aligns with the configured bi-weekly anchor. Otherwise it is built from the daily reports in the exact range. The range is always explicit. A bi-weekly report includes **plan vs. actual**, comparing against the previous bi-weekly report's "Next" items.

### 5.4 Monthly

Built from the daily reports in the calendar month. Weekly reports may be given as context, but they never decide which activities belong to the month, because weeks do not align with months.

### 5.5 Quarterly

Built from the three monthly reports in the calendar quarter. In the Work domain, a quarterly report also proposes the **career log** entry for that quarter (§9.8).

### 5.6 Yearly

Built from the twelve monthly reports.

### 5.7 Calendar and time-zone rules

- The project's time zone decides calendar-day boundaries.
- Timestamps are stored in UTC, with the source time zone kept where it matters.
- Week start day and bi-weekly anchor are set in workspace or project settings.
- Every report stores an explicit range: the start inclusive, the end exclusive.

### 5.8 Evidence references (traceability)

Every bullet or statement in a generated report must either:
- reference at least one record ID, work item ID or input-report statement, or
- be explicitly marked as coming from a user note (which is itself a record).

The report validator **rejects** a version that has unreferenced statements or references to records that don't exist. The UI and the agent interface can expand any reference to its source (a PR link, a Jira issue or a Slack permalink).

Numbers in reports (e.g. "68 PRs merged") come from deterministic queries over Layer 1, not from the model. Each one stores the query and its result.

### 5.9 Coverage and gaps

Every period report shows:
- days with no evidence or no daily report,
- connectors that failed or were truncated during the period,
- stale inputs used.

It must not present an incomplete period as complete.

## 6. Report provenance, revisions and change explanations

When a report changes, the system explains why. Possible reasons:
- New source records were collected.
- A late note was added.
- A connector or repository was added.
- A source record changed or was corrected.
- Guidance changed.
- A lower-level report was regenerated.
- The model or prompt template changed.
- The user requested a rewrite.

The report history shows:
- previous and current versions, with a diff,
- a human-readable change summary,
- evidence references that were added, removed or materially changed,
- guidance changes,
- the input versions used.

Factual changes (new evidence) and editorial changes (instructions or rewrites) are labeled separately.

## 7. Reminders and follow-ups

Reminders are a separate workflow linked to records and reports, not just summary text.

### 7.1 Detection

The system may detect a possible follow-up in a note, message, meeting summary or other source. Examples:
- "The doctor said to ask about the next vaccine at the next visit."
- "Follow up with the contractor about the repair."
- "Review the pull request next week."

AI detection creates a **reminder suggestion**, not an active reminder.

### 7.2 User confirmation

Before activation, the user sees:
- the suggested title,
- why it was suggested, with the supporting records,
- a proposed due date or timing, if the source states one,
- any uncertainty or missing information.

The user can confirm (and set or edit the schedule), save it without a date, edit it, or reject it.

For health, family, financial or other sensitive matters, explicit confirmation is always required. The system must not infer medical advice or invent a due date.

### 7.3 Reminder lifecycle

States: `suggested` → `active` → `snoozed` / `completed` / `dismissed` / `cancelled`.

Each reminder has:
- a stable ID and its project,
- a title and description,
- a due date or recurrence,
- linked records,
- created and updated timestamps,
- a state-change history,
- completion notes,
- an **external reference** (§7.4).

### 7.4 Delivery through existing tools

The hub does **not** run its own notification system in the MVP. A confirmed reminder is created in a tool the user already gets notifications from, chosen per project:
- Work: a Jira issue or a work Google Calendar or Tasks item
- Personal: a personal Google Tasks or Calendar item, or phone reminders

The hub stores the external ID, syncs its state back (completed, snoozed, cancelled), and keeps the link to the original evidence. A built-in scheduler is a later option (§14).

The original source record is never changed by any reminder action.

## 8. Connectors and ingestion

### 8.1 Connector contract

Every input, whatever its tier, produces records that satisfy the **record contract** in `schema.md` §1.

Each connector:
- is configured per workspace and assigned to one or more projects,
- uses the **user's own authorization** with the minimum scopes,
- keeps credentials in the domain's secret store (§11.3), never in records, reports, logs or prompts,
- supports incremental sync with a stored cursor, plus backfill,
- tracks sync status, errors, the last successful cursor, and truncation (e.g. an API history limit),
- keeps source IDs and timestamps, and deduplicates on `source + external_id + content hash`,
- declares its **policy constraints** (§8.6).

### 8.2 Initial connectors (Work domain)

These come from the working prototype (Appendix A):

| Connector | Collects | Notes |
|---|---|---|
| GitHub (Enterprise + github.com) | PRs opened, merged and reviewed; review comments; commits authored | Owner filters (exclude personal repos; include org repos only). The events API keeps ~90 days, so older history comes from search. |
| Jira (Server/DC) | Changes, comments and created issues by the user; status changes by others on watched projects; open assigned issues | Personal access token |
| Confluence (Server/DC) | Pages created or edited, comments | Excludes the user's own work-log pages |
| Slack | Messages the user sent in channels; DMs off by default | Only through an approved integration. Must respect the org's scope policy (e.g. no search scope for personal apps). |
| Google Calendar | Meetings attended (excluding declined, focus and OOO) | |
| Zoom | AI meeting summaries: decisions and action items | Only where summaries are enabled |
| Notes | Manual entry: CLI, UI or agent | Tags: meeting, event, win, blocker, learning, people, decision |

### 8.3 Identity mapping

One person has many identities (e.g. two GitHub logins, a Jira username, a Slack user ID, email addresses). The workspace keeps an **identity map** so connectors can answer "is this mine?": commit authorship, review authorship, comment authorship. Identities from different domains are never mapped together.

### 8.4 Project assignment rules

Ordered rules map records to projects. Examples:
- repo `acme/cli` → CLI
- Jira component or label `Website` → Website
- Slack channel `#support-*` → Support

Records that match no rule go to the workspace's **Unassigned** inbox for the user to classify. Every rule change is versioned and marks the affected bundles stale.

### 8.5 Noise filters

Connectors drop or down-rank activity with no informational value:
- bot commands (e.g. `/ci`),
- merge commits and squash-merge duplicates of already-recorded PRs,
- pushes to shared branches,
- replies on one's own PR recorded as "reviews",
- channels the user excludes.

Filters are configuration, not code.

### 8.6 Data handling and retention

- **Store the minimum.** For chat and email, store a short summary, the permalink and metadata, not full message bodies, unless the user explicitly enables full text for a source.
- Retention is configured per connector. Imported third-party content follows the stricter of the user's setting and the organization's retention policy.
- **Questions or remarks about other people** (e.g. a user's private questions to a chatbot) are not ingested by default.
- Data from the Work domain must follow employer policy. The application must not bypass VPN, SSO or organizational access controls.

### 8.7 Connection methods

**Rule:** prefer OAuth (scoped, revocable, no secret pasted by the user). Accept personal access tokens only where OAuth isn't available or practical (e.g. Atlassian Server/Data Center). Every credential goes into the domain's secret store and is never shown again after entry. Each connection records its granted scopes and who connected it, and can be revoked from the UI.

| Source | Preferred | Fallback | Notes |
|---|---|---|---|
| GitHub / GitHub Enterprise | GitHub App (read-only) or OAuth App, registered **per host** | Fine-grained PAT | Several accounts and hosts per workspace; owner filters per account |
| Jira / Confluence Server/DC | PAT | OAuth via an application link (admin-configured) | Jira and Confluence tokens are separate |
| Jira / Confluence Cloud | OAuth 2.0 (3LO) | API token | Separate implementation from Server/DC |
| Slack | Slack OAuth, user token | — | Must work **without the `search:read` scope** (denied by some orgs). Read the history of the channels the user belongs to, filter to the user's messages, sync incrementally. |
| Google Calendar / Gmail | Google OAuth (an internal app needs Workspace admin approval) | — | Gmail read is a restricted scope (heavier review) |
| Zoom | Zoom OAuth app | — | Meeting-summary scopes; works only where summaries are enabled |
| Microsoft 365 (Outlook, Teams, Calendar) | Microsoft Entra OAuth (Graph) | — | Usually needs admin consent |
| Notes, files, email-in, webhooks | Hub credentials (§11.3) | — | See §8.8, tiers 2–3 |

**Local mode:** the user registers their own OAuth app or uses tokens. **Hosted or SaaS:** the hub owns one registered app per provider (per enterprise host where needed). This is the main cost of SaaS connectors. A managed OAuth-and-sync layer (e.g. Nango, self-hostable) is the preferred way to carry it rather than building each OAuth flow by hand.

### 8.8 Adding new sources

Users can't connect *any* service with zero effort; each API differs in auth, pagination, rate limits and what "my activity" means. The hub offers five tiers, so most sources are reachable without a new built-in connector:

| Tier | Added by | Effort | Description |
|---|---|---|---|
| **1. Built-in connectors** | Hub developers | Days each | First-class, scheduled, complete, deduplicated (§8.1–8.2) |
| **2. Generic inputs** | Any user, no code | Minutes | A per-project **webhook URL** with a signed secret (Zapier, Power Automate, IFTTT, CI systems); **email forwarding** to a per-project address (hosted mode); **file import** (Markdown, CSV, .ics, JSON); RSS/Atom feeds |
| **3. Agent bridge (MCP)** | Any user, no code | Minutes | The user's agent reads any service it is connected to (e.g. Claude's Slack, Gmail, Drive, Zoom, Calendar connectors) and submits records with the MCP `ingest_records` tool. Used today by the prototype for Slack and Calendar. |
| **4. Declarative REST connector** | Power users | Hours | A config file: base URL, auth type, endpoints, pagination, cursor field and a field mapping to the record schema. For simple REST APIs. |
| **5. Connector SDK** | Developers | Days | A TypeScript package implementing `authorize()`, `sync(cursor) → records + nextCursor` and `describe()`, loaded as a plugin |

Rules that apply to every tier:
- **Everything becomes the same record type** (§3.4) with source, external ID, event time and applicable date, so reports, dedup and traceability work identically.
- **Provenance shows the tier.** Records from tiers 2–3 are marked (`via webhook`, `via agent: <client>`). Reports may cite them, but the validator (§5.8) requires a permalink or an external ID, and the UI shows them as lower-trust.
- **Agent-bridge records are complete only when an agent ran.** Coverage (§5.9) reports "agent-sourced: last ingested <time>" instead of claiming full coverage.
- Webhook and email inputs are rate-limited, size-limited, and land in the **Unassigned** inbox unless a project rule matches (§8.4).

MCP tool added to §10.2: `ingest_records(source, records[], project?)` (write): validates the records, deduplicates them on `source + external_id`, and marks affected bundles stale.

## 9. Privacy, members and sharing

### 9.1 Isolation

- Trust domains are physically isolated (§3.1). Members are invited **into a domain's projects**, never across domains. Someone invited to a Personal-domain family project has no access to the Work domain, and cannot see that it exists.
- Within a domain, each project has its own members, records, notes, reports, reminders and visibility.
- Cross-project views are explicit, labeled by project, and only include projects the viewer can access.

### 9.2 Members and roles

Projects can be **shared with other people**, e.g. a family project for a child shared with a spouse, who adds their own notes. Access is granted per project with one role:

| Capability | Viewer | Commenter | Contributor | Manager | Owner |
|---|:-:|:-:|:-:|:-:|:-:|
| See shared records, notes and reports | ✅ | ✅ | ✅ | ✅ | ✅ |
| Comment on records, notes and report statements; react; edit or delete **their own** comments | | ✅ | ✅ | ✅ | ✅ |
| Add notes; edit and delete **their own** notes (as revisions) | | | ✅ | ✅ | ✅ |
| Connect **their own** sources to the project (e.g. their calendar) | | | ✅ | ✅ | ✅ |
| Generate and regenerate reports; add report-scoped guidance | | | ✅ | ✅ | ✅ |
| Create, take and complete reminders; be assigned reminders | | | ✅ | ✅ | ✅ |
| Hide others' notes or comments from shared view (moderation; nothing is deleted) | | | | ✅ | ✅ |
| Project rules, project-wide guidance, settings | | | | ✅ | ✅ |
| Invite and remove Viewers, Commenters and Contributors; publish and share reports outside | | | | ✅ | ✅ |
| Add or remove Managers; transfer ownership; archive or delete the project | | | | | ✅ |

Typical uses:
- **Viewer:** someone who just follows along (e.g. a grandparent).
- **Commenter:** someone who reacts and asks questions but doesn't add to the record (e.g. a teacher or caregiver).
- **Contributor:** a co-author (e.g. a spouse).
- **Manager:** a co-organizer who also invites people.
- **Owner:** the person who created and runs the project.

**Comments are not evidence.** They're attached to a record, note or report statement, and kept with their author and history. They don't feed reports unless a Contributor turns one into a note, which creates a linked note, attributed to both people. This keeps reports built from the record itself, not from the discussion around it.

**Rules:**
- **Authorship is permanent.** Nobody can edit another person's note text, including Owners. Others can comment, add a correcting note, or (Managers) hide it from the shared view. This follows "evidence is preserved" (§17).
- **Credentials are never shared.** A source connected by a member stays theirs. Others see the records it produces (subject to visibility), never the credentials. When the member leaves or disconnects, they choose: keep the records already collected in the project, or remove them.
- **Leaving.** A member who leaves loses access immediately. Their notes stay in the project, attributed, unless they delete them before leaving (as revisions; history is retained for the Owner).
- **At least one Owner.** The last Owner can't leave without transferring ownership.
- Workspaces have one **workspace owner** (the person who runs that hub). Project roles don't grant workspace settings, other projects or connectors.

### 9.3 Item visibility inside a project

Every note, record, report and reminder carries a visibility:

| Visibility | Who sees it |
|---|---|
| `project` | Every project member, by role |
| `private` | The author only (e.g. a personal worry in a shared family project) |
| `restricted` | The author plus selected members |

- Each project sets a **default visibility for new notes** (family project: `project`; work project with colleagues: `private`).
- Records from a member's connected source default to `private` to that member until they choose to share that source with the project.
- Changing visibility is a revision, recorded in the audit log.

### 9.4 Audience-aware reports

A report is generated **for an audience** (one person, a set of members, or the whole project):
- Inputs are filtered to items that **every audience member is allowed to see**. A private note can shape only its author's own reports.
- The validator (§5.8) rejects a report version whose evidence includes anything invisible to any member of its audience.
- The same period can therefore have a *project* report (shared inputs only) and a *personal* report for each member (shared plus their private inputs). The UI makes clear which one you are reading.

### 9.5 Sharing outside the project

- **Report links:** a Manager or Owner can share a **single report version** through a link: read-only, with an expiry, revocable, optionally requiring sign-in (e.g. a monthly summary for grandparents). The link exposes only that report: no evidence, notes or other reports.
- **Publishing:** export or publish to a destination (Confluence, Slack, Google Docs, PDF) after review, built with a "shareable" guidance profile that leaves out private and sensitive details by default.
- Every invite, role change, link, publish and revocation is written to the audit log and visible to Owners.

### 9.6 Accounts and access for shared projects

Sharing needs the hub to be reachable by other people, so **a shared project requires hosted mode** (§11.1) for its domain:
- **Personal domain:** hosted on the user's own cloud account. Sign-in and invitations follow §11.5.
- **Work domain:** shared only with colleagues, on employer infrastructure and employer SSO, and only once security review and data classification allow it (§11.4).
- **Each member's agent** connects with **that member's own token** (MCP over HTTPS) and acts with that member's role and visibility. A spouse's Claude can add notes to the family project, but can't see the project owner's private notes.

### 9.7 Children's and family data

Family projects often hold information about children and other people who are not users:
- **Least data:** store what the family wants recorded, not raw feeds (e.g. calendar event titles and times, not full invitation bodies).
- Health, school and similar details are **sensitive by default**: excluded from report links and publishing unless approved line by line.
- Model calls for this domain use a provider account that doesn't train on the data. Prompts include only the inputs the report needs.
- Children are subjects, not users, in the MVP. Accounts for older children (e.g. a Viewer or Commenter role) are a later option.
- Export and delete cover everything about a subject, on request of an Owner.

### 9.8 Career log (Work → personal, by hand)

The quarterly report proposes **public-safe accomplishment bullets**:
- impact, scope, role and technologies,
- no internal ticket keys, repo names, customer names, hostnames, unreleased plans, or financial or headcount figures.

The user edits and approves them. They accumulate in a career log that can be exported for LinkedIn or a CV. This is the only content designed to leave the Work domain, and only by the user's action.

## 10. Agent access (MCP)

AI agents connect to the hub through a **Model Context Protocol (MCP) server**.

### 10.1 Principles

- **Local transport first.** Streamable HTTP bound to localhost and served by the hub process, so every tool call goes through the service layer and its authorization checks (§16.2), plus a stdio proxy for clients that only launch stdio servers. Agents on the same machine (Claude Code, Codex, Claude Desktop) can connect. A remote MCP endpoint is only offered in hosted mode, behind the same authentication as the UI (§11.3).
- **The MCP server never calls a model.** It collects, stores, versions and validates. The connected agent does the writing and submits the text back. Generation started from the web UI or the scheduler uses the direct path instead (§16.1). Both paths share one pipeline.
- **One domain per server instance.** The Work and Personal hubs are separate MCP servers, with separate config and credentials.
- **No destructive tools.** Notes are append-only. There are no delete tools. Each tool carries a read-only or write annotation so clients can approve reads automatically and ask before writes. Publishing outside the hub needs an explicit `confirm` argument.

### 10.2 Tools (v1)

| Tool | Kind | Purpose |
|---|---|---|
| `search(query, project?, from?, to?)` | read | Full-text search across records, notes and reports |
| `get_day(date, project?)` | read | Daily report and bundle, with evidence |
| `get_report(kind, date, project?, version?)` | read | One report version, with references |
| `get_status(project?)` | read | Open assigned issues, PRs in flight, stale reports, missing days, pending reminder suggestions |
| `get_stats(from, to, project?)` | read | Deterministic counts and lists from Layer 1 |
| `add_note(text, routing?)` | write | Append a note (§3.6). Optional `routing` is the agent's decision: `{kind, projects[], date?, tags[], people[], confidence}`. Without it, or below the confidence threshold, the hub routes the note itself or sends it to the Inbox. |
| `list_inbox()` / `route_note(id, routing)` | read / write | Review and file notes that weren't routed confidently |
| `ingest_records(source, records[], project?)` | write | Agent bridge (§8.8, tier 3): validate and deduplicate records from any service the agent can reach; mark affected bundles stale |
| `add_guidance(scope, text)` | write | Add Layer 4 guidance |
| `get_report_inputs(kind, date, project?)` | read | Exact inputs, guidance, template and the reference format for the agent to write from |
| `save_report(kind, date, markdown, project?)` | write | Validates references (§5.8), records inputs and provenance, creates a version |
| `list_suggestions()` / `resolve_suggestion(id, action, …)` | read / write | Reminder suggestion workflow (§7.2) |
| `publish(report_id, destination, confirm)` | write | Export to a configured destination (e.g. a Confluence work-log page) |

Resources: `hub://day/{date}`, `hub://report/{kind}/{period}`, `hub://record/{id}`.

## 11. Deployment and architecture

### 11.1 Deployment modes

1. **Local mode (MVP):** everything runs on one machine. A single hub process serves the API, the web UI and the MCP server. Data lives in a local PostgreSQL server (Docker) next to it. No account system; the UI is bound to localhost and protected by a per-install token.
2. **Internal production (later):** an internal service for the user and, optionally, teammates. It runs on **one VM** with the hub and Postgres together (§11.4), behind the domain owner's identity provider. A managed PostgreSQL is an option, not a requirement (§16.2). **Work domain:** only on employer-approved infrastructure, with employer SSO. **Personal domain:** on the user's own cloud account.
3. **Multi-user SaaS (possible future):** not built in the MVP, but the data layer is ready for it: a `workspace_id` on every tenant-owned table, row-level security policies, and authorization in the service layer (§16.2). The database moves to a managed service. Adding SaaS means auth, tenancy onboarding and billing, not a data migration.

### 11.2 Logical components

- Web UI
- Service API: workspace, project, records, reports, guidance, reminders
- MCP server, a thin adapter over the service API
- Connector framework and sync scheduler: incremental sync plus a morning daily-report run
- Record store with full-text index
- Bundle builder and staleness tracker
- Report service: input assembly, model call (UI-triggered), validator, versioning
- Exporters: Markdown, Confluence, Slack, Google Docs
- Secret store
- Audit log: sharing, publishing, connector changes, deletions, reminder actions

### 11.3 Security principles

- Local mode: bind to localhost only; use a per-install API token for the UI and HTTP MCP.
- Hosted mode: authenticate every request through the domain's identity provider, and check authorization in the service layer for every project, record, report and reminder.
- Encrypt in transit. Encrypt at rest in hosted mode; in local mode, rely on OS disk encryption.
- Credentials live in the OS credential store locally and in a managed vault when hosted.
- Keep secrets out of logs, prompts, reports and exports.
- Support export and deletion.
- Write audit events for sharing, publishing, permission changes, connector changes, deletions and reminder actions.

### 11.4 Production topology and scaling path

**Start on one machine; split onto several only when expanding or scaling requires it.** Every stage runs the same code. Moving between stages changes configuration and infrastructure, not the application.

| Stage | Topology | Move to the next stage when |
|---|---|---|
| **1. One machine** (MVP and internal production) | One VM (or laptop): Caddy (HTTPS) + hub (UI, API, MCP, jobs) + PostgreSQL, run with Docker Compose. Data on a managed disk. | Downtime for patching is no longer acceptable, or the VM's CPU, memory or disk is a constraint, or more teams start relying on it. |
| **2. Separate database** | The hub VM plus a **managed PostgreSQL** (e.g. Azure Database for PostgreSQL Flexible Server): automatic backups, point-in-time restore, optional high availability. Move with `pg_dump` → `pg_restore` and a `DATABASE_URL` change. | One hub instance can't keep up, or you need zero-downtime deploys. |
| **3. Scaled out** | A load balancer → **N hub instances** (VMs or containers) → managed PostgreSQL (+ read replica if needed). Shared files go to object storage (Blob). Optionally, sync and generation workers run as their own instances. | — |

**Rules from day one, so that stages 2 and 3 need no code changes:**
1. **Stateless hub.** No state lives on the hub's own disk or in memory between requests: sessions, uploads, exports and job state live in Postgres or object storage. Any instance can serve any request.
2. **Configuration from the environment.** `DATABASE_URL`, storage location, identity provider and model keys are environment variables or secrets, never hard-coded paths.
3. **Jobs safe with many workers.** pg-boss jobs are idempotent and claimed with locks, so one, two or ten hub instances can run the scheduler without double-running the morning job.
4. **A file-storage interface.** A local folder in stage 1, object storage (Blob/S3) in stages 2 and 3.
5. **Health and readiness endpoints** (`/healthz`, `/readyz`) and structured logs from the start, which load balancers and monitoring rely on.
6. **Migrations run as a separate step** before deploying (`hub migrate`), never automatically from several instances starting at once.

**Operating requirements for stage 1 in production** (one VM holding both the app and the data):
- **Backups stored off the machine:** a nightly `pg_dump` to Blob storage plus VM disk snapshots. Test a restore at least quarterly. This is mandatory.
- **Planned downtime is accepted:** OS and Postgres patches, restarts and upgrades are scheduled outside working hours.
- **Patching:** automatic OS security updates; Postgres minor versions updated by pulling the new image regularly.
- **Network:** only reachable on the company network or VPN, behind company SSO (e.g. Entra ID). The Postgres port is never exposed outside the VM.
- **Encryption:** encrypted disks; HTTPS through Caddy.
- **Monitoring and alerts:** app down, disk above 80%, and backup failure. A backup that fails silently is the main risk of this stage.
- **Not on Azure Container Apps for Postgres:** it's made for stateless apps and gives no reliable disk for a database. Use a VM with a managed disk in stage 1, and a managed PostgreSQL from stage 2.
- **Company approval:** a production internal service that holds work data needs the employer's security review and data-classification sign-off before it hosts other people's data.

### 11.5 Sign-in and authentication

**No passwords.** The hub never stores password hashes or runs password resets.

| Domain and mode | Sign-in methods |
|---|---|
| **Work, local** | None. The hub listens only on localhost, protected by a per-install token (§11.3). |
| **Work, hosted (colleagues)** | **Company SSO only** (OIDC/SAML via Okta or Entra ID). No social or email sign-in, so access follows the employer's account lifecycle. |
| **Personal, hosted (family)** | **Passkeys, required from the first sign-in, registered through a hardened invite.** No third-party sign-in provider, email service, DNS change or password. A link alone never grants access. <br>• **Invite link:** single-use, expires in **24 hours**, and only allows **registering a passkey**. It never creates a session by itself. <br>• **Confirmation code:** the invite also produces a short code (e.g. `482-913`) that the inviter passes on **through a different channel** (in person, a phone call, another app). Registration needs both the link and the code. Five wrong codes invalidate the invite. <br>• **Owner approval** (a per-project setting, on by default for family projects): a newly registered device stays pending until an Owner or Manager approves it ("New device for <name>, approve?"). <br>• **Sign-in:** passkey only (Face ID, fingerprint, Windows Hello, security key). <br>• **More devices:** synced passkeys (iCloud Keychain, Google Password Manager, etc.), or adding a device by QR code from a signed-in device, which then goes through owner approval. <br>• **Recovery:** a recovery invite (link + code) for the existing member. Their old passkeys are revoked when it's used. <br>• **Leak detection:** if an invite was already used, the real invitee's attempt fails visibly, and the inviter is told to revoke and reissue. <br>• **HTTPS is required:** `localhost` for development, and the hosting platform's default HTTPS hostname (e.g. `*.fly.dev`, `*.azurewebsites.net`) needs no DNS setup. Passkeys are tied to that hostname; moving to a custom domain later means re-registering through recovery invites. <br>**Later, only if needed:** a 6-digit code sent by email (needs an email provider) for devices without passkey support. Google, Microsoft or Apple sign-in is not planned. |

**Invitations:**
- An invitation is a **single-use link plus a confirmation code** for one person and one role. It expires after 24 hours and can be revoked before use. The inviter enters a display name (and, optionally, an email for reference only).
- **A link is assumed to leak** (chat history, forwarding, screenshots). That's why it can only register a passkey, needs the code sent through a second channel, and (where enabled) needs owner approval of the new device. Owners see every pending, used and revoked invite.
- Accepting means creating a passkey, which creates the `User` (if new) and the `ProjectMember` row (§9.2).
- **Recovery and new devices** use the same mechanism: a recovery invite for an existing member, or a QR code shown on a device already signed in.

**Sessions:**
- An HTTP-only, Secure, SameSite cookie, backed by a session table in Postgres, so any hub instance can serve any request (§11.4).
- Members can see and revoke their own sessions. Owners can revoke a member's access, which ends their sessions immediately.

**Agents and API clients:**
- Remote MCP connections use **OAuth 2.1 with PKCE**, as the MCP authorization spec defines. The hub acts as the authorization server, and each token is bound to one user, carrying that user's roles and visibility (§9.6).
- Scripts and clients without OAuth use **personal access tokens**: scoped (read or write, and per project), with an expiry, revocable, and shown only once.
- Every token and session can be revoked from the UI. Token use is written to the audit log.

**Security:**
- Rate-limit sign-in attempts and invite-link redemptions.
- Invite and recovery links are single-use. A recovery invite revokes the member's previous passkeys once it's used.
- Each member can register several passkeys (phone, laptop, security key), so losing one device doesn't lock them out.
- Sign-ins, new devices, token creation and role changes are written to the audit log.

**Implementation:**
- Use an existing library, not custom code. **Preferred: Better Auth** (TypeScript; works with Hono, Drizzle and Postgres; passkey plugin, sessions, and OAuth provider support for MCP). Users and sessions stay in the hub's own database.
- **Alternatives:** a hosted identity service (Clerk, Auth0, Microsoft Entra External ID), if running auth is unwanted. Users would then live with that vendor.
- Confirm the current library support for passkeys and the MCP OAuth flow in a short spike before committing.
- No email provider is needed for sign-in. One is only added if the optional emailed-code fallback is ever enabled.

## 12. Data model (conceptual)

**The concrete PostgreSQL schema is in [`schema.md`](schema.md).** That covers tables, columns, enums, the record contract every input tier must satisfy, row-level security policies and indexes. This section is the conceptual summary.

| Entity | Notes |
|---|---|
| `User` | A person who can sign in (owner, family member, colleague) |
| `Workspace` | One per domain; has one workspace owner; holds settings |
| `ProjectMember` | (project, user, role: viewer, commenter, contributor, manager, owner), with invited-by and dates (§9.2) |
| `Invitation` | Email, role, expiry, status |
| `AuthAccount`, `Passkey`, `Session`, `AccessToken` | Linked sign-in methods per user, sessions, and personal access or OAuth tokens (hashed), each revocable (§11.5) |
| `ShareLink` | A read-only link to one report version, with expiry and revocation (§9.5) |
| `Identity` | The user's account IDs per source (§8.3) |
| `Project`, `ProjectRule` | Assignment rules, ordered and versioned (§8.4) |
| `ConnectorAccount`, `SyncState` | Cursor, status, errors, truncation |
| `Record`, `RecordRevision` | Append-only evidence; notes are records of type `note`. Every record has an **author or owner** and a **visibility** (`project`, `private`, `restricted` + `RecordAudience`) (§9.3). |
| `WorkItem`, `WorkItemLink` | Derived grouping; links carry a confidence and origin (rule or AI) |
| `DailyBundle` | Derived; has a content hash |
| `Report`, `ReportVersion`, `ReportInput`, `EvidenceRef` | Versioned output with exact inputs, per-statement references and an **audience** (§9.4) |
| `Comment` | On a record, note or report statement; author, visibility |
| `Guidance`, `GuidanceVersion` | Scoped instructions |
| `ReminderSuggestion`, `Reminder`, `ReminderEvent` | With an external reference |
| `Export` | What was exported or published, where, when |
| `AuditEvent` | |

Every tenant-owned table also carries `workspace_id`, and row-level security combines `workspace_id`, project membership and item visibility (§16.2).

Key relationships:
- A record contributes to the bundle of its applicable date and project.
- A report version references its exact input versions and guidance versions.
- Evidence references point to record revisions, so a later change to a record never silently alters an old report's meaning.
- An active reminder exists only after user confirmation.
- Workspace aggregate reports reference project reports and never merge records.

## 13. User experience — primary flows

### Flow A: Morning daily run

1. The scheduler (or the user, or an agent) starts the run.
2. Connectors sync incrementally.
3. Bundles are rebuilt for the missing or stale days (catch-up, §5.1).
4. Daily reports are generated (by the UI model call or by an agent through MCP) and validated.
5. The user reviews them, adds guidance if needed, and regenerates.
6. Optionally, the daily report is published to the user's existing log (e.g. the Confluence work-log row).

### Flow B: Late note or new source

1. The user adds a note for a past date, or connects another repository.
2. The new records are associated with the right project and date.
3. Affected bundles are rebuilt; affected daily reports are marked stale.
4. Weekly, monthly, quarterly and yearly reports that depend on them are marked stale.
5. The user, or the automation, regenerates them. The history shows **why** each one changed.

### Flow C: Period report

1. Select the project and period.
2. The system resolves the exact inputs (§5) and shows coverage and gaps (§5.9).
3. Generate, validate (§5.8) and store the version.

### Flow D: Reminder from a note

1. The user records a note.
2. A follow-up is detected and shown as a suggestion with its evidence.
3. The user confirms, edits, rejects, or saves it without a date.
4. The confirmed reminder is created in the configured external tool (§7.4), and its state syncs back.

### Flow E: Cross-project overview (within one domain)

1. Select projects.
2. Generate a combined view. Each item keeps its project label.

### Flow F: Agent conversation

1. In Claude Code, the user asks something like "What did I ship for the CLI this month?" or "Note that the 1:1 agreed to slip beta.1 a week."
2. The agent calls `search` or `get_stats`, or `add_note`.
3. The answer cites record references, and the note shows up in the next daily run.

## 14. MVP scope

**MVP: Work domain, local mode, one user**

1. Record store: append-only records and revisions, a full-text index, and incremental sync state
2. Connectors: GitHub (both hosts), Jira, and manual notes. Port the prototype's Confluence import so the existing history is kept. Agent bridge (`ingest_records`, §8.8 tier 3), so Slack, Calendar and Zoom data can come in through the agent before their built-in connectors exist.
3. Projects with assignment rules, plus an Unassigned inbox
4. Daily bundles with coverage and content hashes
5. Daily, weekly and monthly reports: versioned, validated references, staleness
6. Layer 4 guidance
7. MCP server (§10.2, without reminders and publish)
8. Minimal web UI on localhost: timeline, day view with evidence, report view with version history, notes, guidance
9. Report generation through both paths (§16.1): agent via MCP, and direct via the Claude API once a key is configured
10. Markdown export, plus the Confluence work-log publisher

**Phase 2:** Slack, Calendar and Zoom connectors; bi-weekly, quarterly and yearly reports; the career log; work items with AI-suggested links; reminder suggestions delivered to external tools.

**Phase 3:** a Personal domain instance (its own store and accounts) in hosted mode, with **shared projects**: members and roles, item visibility, audience-aware reports, invitations, and each member's agent access (§9.2–9.7). Also report links and more exporters.

**Not planned:** multi-tenant SaaS for strangers, organization-wide visibility, a built-in notification scheduler.

**Built in from the MVP even though single-user:** `User`, `ProjectMember` with the owner role, visibility on every item, and row-level security keyed on membership. Sharing later is then turning on invitations, not a schema change.

## 15. Key design decisions

| Question | Decision |
|---|---|
| How are work and personal kept apart? | Separate trust domains with physical isolation. No aggregation across domains. |
| Are raw inputs versioned? | Records are append-only, with revisions. There is no mutable "raw daily file". |
| Can daily bundles change? | Yes. They are derived, hashed and rebuilt when evidence changes. |
| Are reports versioned? | Yes. Append-only versions with exact inputs, guidance, generator and a factual/editorial change reason. |
| How is traceability enforced? | Per-statement evidence references, checked by a validator. Numbers come from deterministic queries. |
| Where do editorial instructions live? | A separate, versioned guidance layer, recorded with each report version. |
| Weekly source | Daily reports of the week. |
| Bi-weekly source | Two weekly reports when aligned; otherwise daily reports for the exact range. |
| Monthly source | Daily reports of the calendar month. |
| Quarterly source | Three monthly reports. |
| Yearly source | Twelve monthly reports. |
| When is a daily report generated? | The morning after, with catch-up for missed days. |
| How are reminders delivered? | AI suggests and the user confirms; delivery goes through existing tools (Jira, Google Tasks or Calendar). |
| How do agents connect? | A local MCP server over the service API. The server never calls a model, and there are no destructive tools. |
| Who writes reports? | Both: an agent through MCP, or the hub directly through the Claude API. One shared pipeline and validator (§16.1). |
| Stack | TypeScript on Bun, with Hono, Drizzle + PostgreSQL, pg-boss, React + Vite, and the MCP TypeScript SDK (§16). |
| UI | A browser tab on localhost, served by the local process. |
| Database placement | Local: a PostgreSQL container on the same machine as the hub, on localhost only. SaaS: a separate managed service. All access goes through the hub's service layer, including MCP. |
| SQLite or Postgres? | PostgreSQL everywhere: Docker locally, PGlite in tests, managed Postgres for SaaS. Same version, schema and migrations; SaaS-ready via `workspace_id` + row-level security (§16.2). |
| Deployment shape | One machine (hub + PostgreSQL), including internal production. Split onto several machines only when scaling requires it, with no code changes (stateless hub, config from the environment) (§11.4). |
| Local or hosted? | Local first. Hosted later, on infrastructure that matches the domain. |

## 16. Technology stack

**Decided (2026-11-08):**
- **Option A**, TypeScript end to end on Bun.
- The UI is a **browser tab on localhost**, served by the local process. A Tauri wrapper is optional later.
- Report generation supports **both paths** (§16.1).

### 16.1 Report generation: two paths, one pipeline

| Path | Who writes | Credentials | Used for |
|---|---|---|---|
| **Agent (MCP)** | The connected agent (Claude Code, Codex, Claude Desktop) via `get_report_inputs` → `save_report` | None in the hub | Morning runs started from an agent; conversational edits |
| **Direct (API)** | The hub's report service calls the model | The domain's model key, held in the domain secret store (Work: an employer-provided Claude key) | The "Generate" and "Regenerate" buttons in the UI; unattended scheduled runs |

Both paths use the **same input assembly, prompt template, validator (§5.8) and versioning**. A report version records which path and which model produced it. The direct path is switched off for a domain until a key is configured, and the UI then points to the agent path.

### 16.2 Database: PostgreSQL everywhere

**Decided (2026-11-08):** PostgreSQL is the only database engine, locally and in any hosted or SaaS deployment. Local mode and the cloud run the same engine, schema, migrations and extensions, so moving to the cloud is a dump and restore, not a migration project.

| Environment | Postgres runtime | Placement |
|---|---|---|
| **Local (MVP)** | A regular PostgreSQL server in Docker (`compose.yaml`, named volume). Podman or the native Windows installer work equally well. | **Same machine** as the hub (UI + API + MCP), reached over `localhost`, with its port bound to `127.0.0.1` only. |
| **Tests and CI** | **PGlite** (Postgres compiled to WebAssembly, in memory): a fresh database per test suite in milliseconds, no Docker needed in CI. | Inside the test process |
| **Internal production (later)** | The same Docker Compose setup (Caddy + hub + Postgres) on one VM | **Same machine.** The supported production setup for an internal service, under the operating requirements in §11.4. |
| **Large multi-user SaaS (if ever)** | A managed PostgreSQL (e.g. Azure Database for PostgreSQL Flexible Server). Data moves with `pg_dump` → `pg_restore`. | **Separate service, recommended, not required.** Worth it once there are many users: the app can scale out, and the database gets managed backups, point-in-time recovery, high availability and patching. Until then, keeping Postgres on the same machine as the app is fine. |

**Rules:**
1. **Pin one major version** (e.g. PostgreSQL 17) across local, tests and the target managed service.
2. **Use only extensions the target managed service supports.** Planned: `pgvector` (semantic search for the MCP `search` tool) and `pg_trgm` (fuzzy matching for work-item linking). Full-text search uses the built-in `tsvector` with GIN indexes.
3. **One schema and one set of migrations:** Drizzle `pg` schema plus Drizzle Kit migrations, applied the same way in every environment.
4. **Native types:** `timestamptz` for event, captured and entered times; `date` for applicable dates; `jsonb` for source payloads; `boolean`; text ULIDs (sortable by time) for IDs.
5. **SaaS-ready from day one:**
   - Every tenant-owned table has a non-null `workspace_id`, and every index that serves user queries starts with it.
   - Row-level security policies keyed on `workspace_id` are written and tested from the MVP, even though local mode has one workspace. Turning on multi-tenancy is then configuration, not a schema change.
6. **All access goes through the service layer.** The UI API, the scheduler and MCP all call the hub's service layer; nothing else connects to the database (apart from admin and backup tools). Authorization logic stays in one place and carries over to the cloud unchanged.
7. **The connection is configuration only** (`DATABASE_URL`). Same machine, another VM or a managed service needs no code changes.
8. **Backups:** a nightly `pg_dump` (custom format) to the domain's backup location, plus the Markdown export of reports (§4, Layer 3). Hosted mode adds the managed service's point-in-time recovery.

**Job queue:** pg-boss on the same database, locally and hosted. No in-process scheduler is needed.

**Why not SQLite:**
- It would need two schemas, tests on two engines and a migration tool to keep the cloud path open.
- It has no row-level security, no concurrent writers and no pgvector.
- Its one advantage, no server, is worth less than having the same engine everywhere.

### 16.3 Options considered

Constraints that drive the choice:
- runs locally on Windows, macOS and Linux (the hub process plus a Postgres container),
- the same code runs in a cloud container with a managed Postgres,
- first-class MCP support,
- types shared between the UI, the API and the MCP tools,
- a small team (one developer plus agents).

### Option A — TypeScript end to end (recommended)

| Layer | Choice | Why |
|---|---|---|
| Runtime | **Bun** (Node-compatible) | Fast, TypeScript-native, and has a built-in test runner. Already used in an earlier CLI project. |
| API | **Hono** | Small, typed routes, and runs on Bun, Node or a container unchanged. |
| Validation and shared types | **Zod** | One schema for API input, MCP tool input and UI forms. |
| Database | **PostgreSQL** through **Drizzle ORM** + Drizzle Kit migrations | See §16.2. Docker locally, PGlite in tests, managed Postgres when hosted. `tsvector` for search, `pgvector` for semantic search. |
| Jobs | **pg-boss** on the same Postgres | Cron-style morning runs, retries and sync jobs, with no extra infrastructure. |
| MCP | **@modelcontextprotocol/sdk** (TypeScript) | The reference SDK. stdio plus Streamable HTTP. |
| Model calls | **Anthropic TypeScript SDK** | Only for reports triggered from the UI. |
| Frontend | **React + Vite**, **TanStack Router + Query**, **Tailwind + shadcn/ui** | A single-page app served by the same process. No server-rendering framework is needed for a local-first app. |
| Charts and timeline | Recharts or visx | Activity heatmap, per-period numbers. |
| Secrets | OS keychain (local); managed vault (hosted) | |
| Desktop (optional) | **Tauri** wrapper later | A tray icon, the morning run, and notifications if ever needed. |
| Tests | Vitest + Playwright | |

### Option B — Python backend + React frontend

FastAPI, SQLModel/SQLAlchemy and Alembic, with Postgres, APScheduler, the Python MCP SDK (FastMCP), and React + Vite for the UI.

- **For:** the prototype's connectors are already Python, and Python has strong data tooling.
- **Against:** two languages, with types duplicated across the API and the UI (generated through OpenAPI), and harder single-binary packaging.

### Option C — Rust core

Axum, sqlx and the Rust MCP SDK, with the same React UI.

- **For:** the best single-binary story, and consistent with an earlier CLI project's Rust port.
- **Against:** the slowest to iterate on connectors and report logic, which is where most of the change will be.

**Chosen: Option A.** The product is mostly API, connectors and UI around a database. One language with shared Zod schemas across the API, MCP and UI removes a whole class of mismatch bugs. The same code runs locally next to a Postgres container and in a cloud container next to a managed Postgres. The prototype's Python connector logic (~800 lines) is small enough to port.

## 17. Open questions

- **Project list** for the Work domain, and the initial assignment rules.
- **Week start and bi-weekly anchor:** defaults are Monday and 2024-01-01.
- **Automation:** should the morning run regenerate reports automatically, or only mark them stale?
- **Work Claude API key:** how to get one, and its budget, for the direct generation path (§16.1). Agent-only works until then.
- **Retention periods** per connector, especially Slack and meeting summaries.
- **Employer approvals** needed for hosted Work-domain mode: infrastructure, SSO, data classification.
- Whether the **Personal domain** shares the codebase as a separately configured instance (recommended) or is a different product.

## 18. Guiding principle

**Evidence is preserved; derived views can evolve.**

Source records and user notes are the evidence. Daily bundles organize it. Versioned reports explain it at different time scales, and every statement points back to it. Guidance steers how it is presented. Reminders turn confirmed follow-ups into tracked actions in the tools the user already uses. Projects keep contexts apart within a domain, and trust domains keep work and personal life apart.

---

## Appendix A — Current prototype (`worklog` skill)

The spec builds on a working prototype:
- the script `worklog.py`,
- the skill's `SKILL.md`,
- data in `~/worklog`.

**Already proven:**
- GitHub, Jira and Confluence collection with owner and noise filters
- Slack through the claude.ai connector; Calendar
- Morning-after daily logs with catch-up
- Personal notes
- Weekly, biweekly, monthly, quarterly and yearly reviews built from logs plus deterministic stats
- A Confluence work-log mirror with an edit-conflict guard
- Several years of daily logs imported from Confluence

**Gaps against this spec:**
- `raw/` digests are overwritten, not append-only records.
- There are no evidence references per statement and no validator.
- There are no work items or project assignment rules; areas are inferred by the model.
- Reports are versioned only through git, with no recorded inputs or hashes.
- There is no MCP server or UI.

**Migration:**
- Import `~/worklog/daily`, `notes` and `reviews` as records of type `note` / `imported-log`, plus report versions with source `prototype`.
- Keep the Confluence importer as a connector.
- The prototype stays in use until the MVP reaches the same coverage.
