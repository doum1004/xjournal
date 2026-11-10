import type { ReportKind } from '@xjournal/core';

// Report templates (plan.md M3): the sections and the writing instructions an agent or the
// direct path gets with the inputs. They carry over the prototype skill's format rules, plus
// the citation rules (api.md §4.2). Bump `version` when the instructions change, so versions
// written from older templates can be told apart (schema.md §7 `template_version`).

export interface Template {
  version: string;
  sections: string[];
  instructions: string;
}

const CITATIONS = `Citations (required, the validator rejects a version without them):
- Every bullet and paragraph ends with at least one citation of its evidence: [[r:<recordRevisionId>]] for a record or note from the inputs, [[v:<reportVersionId>#<anchor>]] for a statement of an input report, [[w:<workItemId>]] for a work item.
- A lead-in bullet ending in ":" needs no citation when every bullet under it has one. The TL;DR needs none either.
- Numbers that count things (PRs, commits, issues, pages, meetings…) come from stats only: "Merged 12 PRs [[s:prs_merged]]". Otherwise leave the number out.
- Cite only what's in the inputs, and only records whose date is inside the period.
- Headings use "## ". No front matter; the hub adds it on export.`;

const DAILY: Template = {
  version: 'daily@3',
  sections: ['<one ## heading per area that had work>', 'Reviews', 'Meetings', 'Watched', 'Notes'],
  instructions: `Write the day's work log from the bundle, in the user's own style.

- One "## <Area>" heading per area that had work (for example SDK, CLI, Studio, Toolkit, Website, Infra, Support), then "## Reviews", "## Meetings", "## Watched" and "## Notes" when they have content. Only include areas that had work.
- Write what was achieved and why, in plain past tense, one bullet per piece of work, not one per event. Collapse "opened → review comments → fixed → merged" into a single bullet, citing each of those records. Put PR lists as nested bullets under a lead-in.
- The bundle groups records into work items: one Jira issue or PR with its PRs, commits, Slack threads and meetings. A work item is usually one bullet: cite [[w:<id>]] and the records it rests on. A record with suggestedWorkItems holds its place in that item on the model's guess: if you describe it as part of the item, write "(suggested link)" after its citation; if the guess doesn't fit, treat it on its own.
- Jira keys as [PIX-123]. Use **bold**, \`code\`, [text](url) and <url> only.
- Leave out noise: CI re-runs, bot commands, rebases, branch create/delete. Other people's watched changes go under "## Watched" (at most 3 bullets), only if they affect the user's work.
- Every note from the inputs (records of kind "note") appears somewhere: in its area, under Meetings, or under Notes.
- If the guidance says otherwise, follow the guidance.
- Aim for 5–20 bullets. No secrets or tokens.

${CITATIONS}`,
};

const WEEKLY: Template = {
  version: 'weekly@2',
  sections: [
    'TL;DR',
    'Shipped',
    'Progress by area',
    'Reviews & collaboration',
    'Meetings & events',
    'Blockers / risks',
    'Next week',
  ],
  instructions: `Write the weekly review from the week's daily reports (inputReports) and stats.

Sections: "## TL;DR" (2–3 lines) · "## Shipped" (merged or released, with links) · "## Progress by area" · "## Reviews & collaboration" · "## Meetings & events" · "## Blockers / risks" · "## Next week" (3–5 items).

- Cite the daily reports' statements: [[v:<versionId>#<anchor>]]. You may also cite records directly.
- workItems lists each piece of work active this week, with the days it was touched. Describe a piece of work once, even when it ran over several days: one bullet citing [[w:<id>]] and the daily statements about it.
- Days in gaps.missingDays have no daily report: say so under Blockers / risks if it matters, and don't invent their content.
- "Next week" items are plans, not facts: cite the evidence they follow from (an open PR, a note).

${CITATIONS}`,
};

const MONTHLY: Template = {
  version: 'monthly@2',
  sections: [
    'TL;DR',
    'Highlights',
    'By area',
    'Numbers',
    'Collaboration & people',
    'Learnings',
    'Gaps',
    'Next month',
  ],
  instructions: `Write the monthly review from the month's daily reports (inputReports) and stats.

Sections: "## TL;DR" · "## Highlights" (top 3–5, each with its impact) · "## By area" · "## Numbers" (from stats only) · "## Collaboration & people" (help given and received, feedback) · "## Learnings" · "## Gaps" (days with no report from gaps.missingDays; things the stats show that the reports missed) · "## Next month".

- Write "## Numbers" as bullets, each citing its metric: "- PRs merged: 42 [[s:prs_merged]]".
- workItems lists each piece of work active this month, with the days it was touched. Write about the work, not the days: one statement per piece of work, citing [[w:<id>]] and the daily statements about it.

${CITATIONS}`,
};

const BIWEEKLY: Template = {
  version: 'biweekly@3',
  sections: [...WEEKLY.sections.slice(0, -1), 'Plan vs. actual', 'Next two weeks'],
  instructions: `Write the bi-weekly review from its two weekly reports (inputReports) and stats.

Sections: "## TL;DR" (2–3 lines) · "## Shipped" · "## Progress by area" · "## Reviews & collaboration" · "## Meetings & events" · "## Blockers / risks" · "## Plan vs. actual" · "## Next two weeks" (3–5 items).

- Cite the weekly reports' statements: [[v:<versionId>#<anchor>]]. workItems lists each piece of work active in the two weeks; cite [[w:<id>]] when a statement is about one.
- "## Plan vs. actual": take the "Next" items of the previous bi-weekly (in \`previousPeriod\`) and mark each ✅ done, 🟡 partly or ❌ not done, with a reason. Cite the plan item ([[v:<previousPeriod.versionId>#<anchor>]]) and the evidence of what happened. With no previousPeriod, write one line saying there was no earlier plan, citing a statement it follows from, or leave the section out.
- Weeks in gaps.missingInputs have no weekly report: say so under Blockers / risks, and don't invent their content.

${CITATIONS}`,
};

const CAREER_RULES = `"## Career log": 3–6 public-safe accomplishment bullets for the user's career log (it can leave the Work domain, by the user's hand only):
- Write them as on a public profile: impact, scope, the user's role and the technologies.
- Leave out internal ticket keys, repo names, customer names, internal hostnames and IPs, URLs, unreleased plans, and financial or headcount figures. Use public product names only. When unsure, generalize ("a major automotive customer").
- End with a bullet "Skills: <comma-separated list>".
- Cite each bullet like any other statement; the citations are dropped when the bullets are copied to the career log.`;

const QUARTERLY: Template = {
  version: 'quarterly@2',
  sections: [
    'Summary',
    'Impact themes',
    'Numbers',
    'Growth',
    "What I'd do differently",
    'Next quarter goals',
    'Career log',
  ],
  instructions: `Write the quarterly review from the quarter's monthly reports (inputReports) and stats, in the first person.

Sections: "## Summary" (one paragraph) · "## Impact themes" (3–5, each as **Problem → What I did → Result**) · "## Numbers" (from stats only) · "## Growth" (skills, new areas, ownership taken on) · "## What I'd do differently" · "## Next quarter goals" · "## Career log".

- Separate impact from activity. Cite the monthly reports' statements: [[v:<versionId>#<anchor>]].
- Write "## Numbers" as bullets, each citing its metric: "- PRs merged: 42 [[s:prs_merged]]".
- Months in gaps.missingInputs have no monthly report: say so in the Summary, lean on stats for them, and don't guess.

${CAREER_RULES}

${CITATIONS}`,
};

const YEARLY: Template = {
  version: 'yearly@2',
  sections: [
    'The year in one paragraph',
    'Quarter by quarter',
    'Top accomplishments',
    'Numbers',
    'Skills grown',
    'Recognition & feedback',
    'Next year',
  ],
  instructions: `Write the yearly review from the year's monthly reports (inputReports) and stats, in the first person.

Sections: "## The year in one paragraph" · "## Quarter by quarter" (2–3 lines each) · "## Top accomplishments" (5–8, impact first) · "## Numbers" (year totals, from stats only) · "## Skills grown" · "## Recognition & feedback" · "## Next year".

- Cite the monthly reports' statements: [[v:<versionId>#<anchor>]].
- Write "## Numbers" as bullets, each citing its metric.
- Months in gaps.missingInputs have no monthly report: say so in the first paragraph, lean on stats, and don't guess.

${CITATIONS}`,
};

export function templateFor(kind: ReportKind): Template {
  switch (kind) {
    case 'daily':
      return DAILY;
    case 'weekly':
      return WEEKLY;
    case 'biweekly':
      return BIWEEKLY;
    case 'monthly':
      return MONTHLY;
    case 'quarterly':
      return QUARTERLY;
    case 'yearly':
      return YEARLY;
  }
}

export const REF_FORMAT =
  '[[r:<recordRevisionId>]] · [[w:<workItemId>]] · [[v:<reportVersionId>#<anchor>]] · [[s:<metric>]]';
