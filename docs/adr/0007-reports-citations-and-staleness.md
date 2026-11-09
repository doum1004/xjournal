# ADR 0007: Reports: inputs, citations, validation and staleness

**Status:** Accepted, 2026-11-09 (M3)

## Context

M3 (`plan.md` §2) replaces the prototype `worklog` skill: an agent writes daily, weekly and monthly reports over MCP, and every statement must be traceable to evidence (spec §5.8). The hub has to decide what an agent sees, how citations are written and checked, when a report becomes stale, and how the prototype's history and Confluence work log carry over.

## Decision

**Inputs are assembled by the hub, not chosen by the agent.** `get_report_inputs` resolves the logical report (project × kind × period × audience) and returns its evidence: for a daily report, the day's records from a freshly rebuilt bundle; for a period report, the constituent reports with every statement's anchor. Also: guidance (most specific first), context notes, the previous version, deterministic stats and gaps. Records are filtered to what **every** audience member may see: all the caller sees for a personal report, project-visible records for a shared one.

**One hash for the inputs.** `inputHash` covers the template version, the input bundles' and versions' hashes, the guidance versions, and the set of citable revisions. `save_report` recomputes it and answers 409 `stale_input` on a mismatch, so a report is never saved against evidence that changed while it was written.

**Citations are tokens in the Markdown.** `[[r:<revisionId>]]`, `[[v:<versionId>#<anchor>]]`, `[[w:<id>]]`, `[[s:<metric>]]`. A statement is a bullet (with its indented continuation lines) or a paragraph; its anchor comes from its section and text without citations, so an unchanged bullet keeps its anchor across versions. The validator (`packages/reports`, pure) rejects unreferenced statements (lead-ins whose sub-bullets are all cited, and the TL;DR, are exempt), unknown, invisible or out-of-period references, unknown stats, malformed tokens, and counts that don't cite a stat. Every error carries the statement's anchor and line and a hint written for an agent to act on. Accepted citations are stored as `evidence_refs`, and cited stats with their query in `report_stats`.

**Change reasons follow the inputs.** The first version is `initial`; a later one is `factual` if its input hash differs from the previous version's, otherwise `editorial`. After the first, a change summary is required.

**Staleness is one system query, run after anything that can change inputs** (a morning run, a sync, a saved version, archived guidance). A report is stale when a recorded bundle's hash changed, a recorded input version is no longer its report's current one (or that report is stale), a guidance version was replaced or archived, or the set of current constituent reports in its period changed. The query repeats until nothing changes, so staleness climbs daily → weekly/monthly → quarterly/yearly. Reports are flagged, never silently regenerated.

**What's due is computed, not scheduled.** `get_status.due` lists, oldest first, weekdays of the last 14 days that have evidence but no daily report, stale reports of the last two months, and last week's and month's reviews once their dailies exist. The `morning_run` prompt walks it. The hub's 07:00 job prepares the evidence (sync and bundles); the agent writes.

**The prototype's history becomes reports.** `hub import reports` turns each imported daily log into that day's daily report (path `import`, citing the log record, with no recorded inputs, so it never goes stale) and each review into its period's report, stale until rewritten (schema.md §11).

**Confluence mirroring keeps the prototype's guard.** A daily report's text, with citations removed, is published as its row on the month page. The hub records a fingerprint of each row it writes (`exports.content_hash`), and refuses to overwrite a row whose text differs from it, including rows written before the hub, unless forced. With `worklog.mirrorDaily` on the Confluence connector, every saved daily report is published, and the outcome goes back to the saver. MCP has no `publish` tool yet (plan.md M3).

## Evidence

- `packages/reports/test/reports.test.ts` (statements, anchors, every validation code, periods); `packages/services/test/reports.test.ts` (resolve, inputs, stale_input, validation, versions, staleness climbing to the weekly, guidance, audience filtering, status, the prototype import); `packages/services/test/publish.test.ts` and `packages/connectors/test/confluence-publish.test.ts` (the guard); `apps/server/test/mcp.test.ts` (status → inputs → a rejected save → a valid save → read, over MCP); `packages/db/test/rls.test.ts` (one test per report, guidance and export policy).
- On real data (2026-11-09): 625 prototype logs and 2 reviews imported; a daily report for 2026-11-06 written from the real inputs (101 records) and saved with 94 citations, all resolving to their PRs, commits and comments.

## Consequences

- An agent can only cite what the inputs list, so evidence the connectors missed (e.g. outside a truncated event feed) can't be claimed; it can be added as a note first.
- Imported daily reports carry no inputs, so later evidence for those days doesn't mark them stale. Regenerating one is a deliberate act.
- `audience: 'project'` reports freeze their audience at creation; members who join later aren't added (M7, with members and roles).
- Report generation without an agent (the direct path) is M4; it reuses the same inputs and validator.
