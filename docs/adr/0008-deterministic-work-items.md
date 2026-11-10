# ADR 0008: Work items: deterministic links

**Status:** Accepted, 2026-11-10 (M6, first part)

## Context

The same piece of work shows up in several sources: a Jira issue, its PRs and their reviews, commits, a Slack thread linking the PR, a meeting named after the issue (spec §3.5). Reports described each event separately, and weekly and monthly reports had no way to see that Monday's PR and Thursday's merge were the same work. M6 adds work items. This ADR covers the deterministic half; AI-suggested links come later and are stored beside these with `origin = 'ai'` and a confidence.

## Decision

**Two kinds of anchor.** A Jira issue (`key = 'PIX-123'`), known from Jira's own records (`payload.issue`), and a pull request (`key = 'owner/repo#12'`), known from GitHub's records (`payload.repo` and `payload.number`: the PR itself, its reviews and comments).

**References in text link records to anchors.** Titles and summaries are scanned for Jira keys, Jira `/browse/` links and pull request links. A Jira-key-shaped token whose prefix is on a short stop list (`UTF`, `SHA`, `ISO`, `RFC`…) is ignored, unless Jira records show that prefix is a real project.

**Pull requests fold into their issues.** When a pull request's own records name a Jira key, the PR and every record that references it (e.g. a Slack message linking the PR) join the issue's item instead of forming their own. A PR naming two issues joins both.

**What is left out.** Imported prototype logs and context or guidance notes (they summarize many pieces of work); Jira records' references to other issues ("duplicates PIX-9"); and any record mentioning more than three anchors (a standup roundup), which would otherwise join unrelated work.

**An item needs two records.** A single record already describes itself; grouping it adds nothing. Each anchor with two or more records becomes an item.

**Branch names are not used yet.** The connectors don't store them. GitHub's issue search, one of the two PR streams, doesn't return a PR's head branch, so adding it would make the two streams disagree and add a revision on every sync. Adding it to commits would add a revision to 90 days of commits and mark their reports stale. Keys in PR titles and commit messages already cover most of the real data (below).

**Derived and rebuildable.** Linking is a pure function over a project's non-hidden records (`planWorkItems`), saved by a system job (`relinkWorkItems`) that runs in the morning run before the bundles, before report inputs are assembled, and with `hub bundles`. Items are matched by `(project_id, key)`, so an item keeps its ID across rebuilds: reports cite it. A rebuild only touches `origin = 'rule'` links; an item with no links left keeps its row and disappears from views. Records are never changed.

**Visibility.** A link is visible when its record is. An item is visible to project members who can see at least one of its links, so nobody learns of an item made only of records hidden from them. Its title is taken from project-visible records when it has any, so a shared item never shows a private record's text.

**Where items appear.** The day view and a daily report's bundle group records by item (a record in two items appears in both), with the rest under `unlinked`. Weekly, bi-weekly and monthly inputs list the period's items with their days and record kinds (`ReportInputs.workItems`). Quarterly and yearly reports don't: a quarter has hundreds of items, and those reports work from monthly reports. Every listed item can be cited as `[[w:<id>]]`; citations show its title and link. The input hash covers how the period's revisions group into items, so a relink between reading inputs and saving answers 409 `stale_input`. Bundle hashes don't include the grouping: it's presentation over the same records, so a relink doesn't mark reports stale.

## Evidence

- `packages/services/test/workitems.test.ts`: text anchors and the stop list; folding a PR and the Slack message linking it into the issue; PR-only items; titles; the exclusions; a relink that keeps IDs and drops a link; visibility through the day view; daily and weekly inputs; citing an item; an unknown item rejected.
- `packages/db/test/rls.test.ts`: `work_items_select` and `work_item_links_select`.
- Dry run on real data (2026-11-10, the `work` project, GitHub only, no Jira yet): 1,518 records (625 imported logs, skipped) → 291 items linking 853 records: 183 PIX issues and 108 PRs without one. No false Jira keys. The largest item, PIX-9212, joins 2 PRs, 58 commits and 2 review comments.

## Consequences

- Without Jira records, an issue's title comes from a PR title naming it ("feat(PIX-9212): …" → "PIX-9212 …"). Once Jira syncs, the issue's own summary replaces it at the next relink.
- A relink reads every record of the project. That's fine at today's size (about 1,500 records); a project with hundreds of thousands of records would need incremental linking.
- Commits on a branch whose messages don't name the issue stay unlinked until branch names are stored.

## Open items

- AI-suggested links (`origin = 'ai'`, with confidence), marked as such in reports (spec §3.5).
- Linking and unlinking by hand in the UI (`origin = 'user'`), which relinking already leaves alone.
- Branch names, if a connector can supply them consistently.
