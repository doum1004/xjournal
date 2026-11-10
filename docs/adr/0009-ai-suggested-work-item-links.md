# ADR 0009: Work items: AI-suggested links

**Status:** Accepted, 2026-11-10 (M6, second part)

## Context

Deterministic links (ADR 0008) only join records that name their work: a Jira key, a Jira link, a PR link. Much of a day's evidence doesn't: a commit on a feature branch whose message is "wire the flag", a Slack thread about "the rollout", a meeting called "Flag sync". The spec (§3.5) allows a second pass: the model proposes links, they are stored as suggestions with a confidence, and reports may use them only if they're visibly marked.

## Decision

**What the model is asked.** After the rule links are rebuilt, for each project: every non-hidden record of the last 14 days that is in no work item at all, given to the model with the project's work items that have a record in those 14 days. Each item is shown by its title and the titles of its latest four records. Records are labelled `r1…` and items `w1…`, so the model never handles an ID. It answers JSON `{"links":[{"record","item","confidence"}]}`. Imported logs and context or guidance notes are not asked about, for the reasons rules skip them. Without items there is nothing to place a record in, so nothing is asked.

**What is kept.** Links at confidence 0.6 or higher, at most one item per record (the most confident). They're stored as `work_item_links` rows with `origin = 'ai'` and the confidence. Unknown labels are ignored. An answer that isn't the JSON asked for fails that batch.

**Asked once per revision.** `work_item_ai_checks` records each record asked about and the revision the model saw. A record is asked again only when it gets a new revision. A failed batch isn't marked, so it's asked again next run. This keeps the daily cost to the day's new records.

**Rules win.** When a rule links a record, any guess about that record is deleted at the same relink, including a guess for the same item: the rule link replaces it. A guess for a record never blocks a rule link, and relinking never removes a guess otherwise.

**Where it runs.** In the morning run between the relink and the bundles, and on demand with `hub suggest-links`. It needs the Claude API key already used for direct report generation, and does nothing without one (`status: 'no_key'`). `hub run --no-suggest` skips it. The model is `claude-sonnet-5-5`: matching is classification, not writing. Batches hold 40 records.

**How it shows.**
- `RecordView.suggestedWorkItems` maps each item a record is in only by guess to the confidence.
- The day view shows those records under the item with a "suggested · 80%" badge.
- Daily inputs carry the field. The hub's own prompt marks the line "(suggested link, 80% confident)". The daily template (`daily@3`) and the generation rules say to write "(suggested link)" after the citation when the report treats the record as part of the item, and to describe it on its own when the guess doesn't fit.
- Weekly, bi-weekly and monthly item summaries count the guessed records (`WorkItemSummary.suggested`).
- The report input hash includes which links are guesses, so a guess appearing or being superseded between reading inputs and saving answers 409 `stale_input`. As with rule links, bundle hashes don't change.

**Visibility.** Guesses are `work_item_links` rows, so ADR 0008's policies apply unchanged. `work_item_ai_checks` belongs to the system job: row-level security is forced, and `hub_app` has no grant or policy on it. The model sees the titles and summaries of every record it's asked about, including private ones, as it does when it writes the owner's reports with the same key.

## Evidence

- `packages/services/test/suggest.test.ts`:
  - the prompt's labels;
  - parsing the answer: unknown labels, low confidence, best item per record, malformed answers;
  - no key means nothing is asked;
  - a guess is stored and shown, a weak one isn't, and imported logs aren't asked about;
  - a record is asked once per revision;
  - a failed call is asked again;
  - the daily marker and the weekly count;
  - a rule supersedes a guess;
  - the morning run with and without `--no-suggest`.
- `packages/db/test/rls.test.ts`: `hub_app` cannot read `work_item_ai_checks`.

## Consequences

- With a key stored, every morning run makes at least one model call per project that has new unlinked records. At today's volume that is one or two calls a day.
- A guess outlives an edit of its record: the record is in an item, so it isn't asked about again. Only a rule link, or a user unlink (when it exists), removes it.
- Items without a record in the last 14 days aren't offered, so a late note about older work stays unlinked.

## Open items

- Linking and unlinking by hand (`origin = 'user'`). An unlink of a guess also needs to stop the record being asked again; the check row already does that while the revision is unchanged.
- Suggesting new items (a theme with no Jira issue or PR), not only placing records in existing ones.
- Asking through the agent bridge for users without an API key.
