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
  version: 'daily@1',
  sections: ['<one ## heading per area that had work>', 'Reviews', 'Meetings', 'Watched', 'Notes'],
  instructions: `Write the day's work log from the bundle, in the user's own style.

- One "## <Area>" heading per area that had work (for example SDK, CLI, Studio, Toolkit, Website, Infra, Support), then "## Reviews", "## Meetings", "## Watched" and "## Notes" when they have content. Only include areas that had work.
- Write what was achieved and why, in plain past tense, one bullet per piece of work, not one per event. Collapse "opened → review comments → fixed → merged" into a single bullet, citing each of those records. Put PR lists as nested bullets under a lead-in.
- Jira keys as [PIX-123]. Use **bold**, \`code\`, [text](url) and <url> only.
- Leave out noise: CI re-runs, bot commands, rebases, branch create/delete. Other people's watched changes go under "## Watched" (at most 3 bullets), only if they affect the user's work.
- Every note from the inputs (records of kind "note") appears somewhere: in its area, under Meetings, or under Notes.
- If the guidance says otherwise, follow the guidance.
- Aim for 5–20 bullets. No secrets or tokens.

${CITATIONS}`,
};

const WEEKLY: Template = {
  version: 'weekly@1',
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
- Days in gaps.missingDays have no daily report: say so under Blockers / risks if it matters, and don't invent their content.
- "Next week" items are plans, not facts: cite the evidence they follow from (an open PR, a note).

${CITATIONS}`,
};

const MONTHLY: Template = {
  version: 'monthly@1',
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

${CITATIONS}`,
};

const GENERIC = (kind: ReportKind, from: string): Template => ({
  version: `${kind}@1`,
  sections: ['TL;DR', 'Highlights', 'By area', 'Numbers', 'Next'],
  instructions: `Write the ${kind} review from the ${from} reports (inputReports) and stats, with "## TL;DR", "## Highlights", "## By area", "## Numbers" (from stats) and "## Next".

${CITATIONS}`,
});

export function templateFor(kind: ReportKind): Template {
  switch (kind) {
    case 'daily':
      return DAILY;
    case 'weekly':
      return WEEKLY;
    case 'biweekly':
      return {
        ...WEEKLY,
        version: 'biweekly@1',
        instructions: `${WEEKLY.instructions}\n\nAdd "## Plan vs. actual": check the previous bi-weekly's "Next" items (in \`previous\`) as ✅, 🟡 or ❌ with a reason.`,
      };
    case 'monthly':
      return MONTHLY;
    case 'quarterly':
      return GENERIC('quarterly', 'monthly');
    case 'yearly':
      return GENERIC('yearly', 'monthly');
  }
}

export const REF_FORMAT =
  '[[r:<recordRevisionId>]] · [[w:<workItemId>]] · [[v:<reportVersionId>#<anchor>]] · [[s:<metric>]]';
