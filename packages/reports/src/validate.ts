import {
  type Citation,
  malformedCitations,
  type Statement,
  statementsOf,
  stripCitations,
} from './markdown';

// The report validator (spec §5.8, api.md §4.4). Pure: the caller resolves what each cited
// ID points to and passes it in as `known`.

export type ValidationCode =
  | 'unreferenced_statement'
  | 'unknown_ref'
  | 'invisible_ref'
  | 'out_of_period'
  | 'number_without_stat'
  | 'unknown_stat'
  | 'malformed_ref'
  | 'empty_report';

export interface ValidationError {
  code: ValidationCode;
  anchor?: string;
  line?: number;
  text?: string;
  ref?: string;
  hint: string;
}

export interface KnownRefs {
  /** Record revisions: their applicable date and whether every audience member may see them. */
  revisions: Map<string, { applicableDate: string; visibleToAudience: boolean }>;
  /** Input report versions, with their statement anchors. */
  versions: Map<string, Set<string>>;
  workItems: Set<string>;
  stats: Set<string>;
  period: { start: string; endExcl: string };
}

export interface ValidationResult {
  ok: boolean;
  errors: ValidationError[];
  statements: Statement[];
  /** Every citation, by statement anchor, for `evidence_refs`. */
  refs: { anchor: string; citation: Citation }[];
}

// A count or total: "3 PRs", "12 merged PRs", "1,200 commits"... digits only, so IDs like
// PIX-123, #215 and versions (v1.2, "the 2026.6 release") don't trip it.
const COUNT_RE =
  /(?<![\w#./:-])\d{1,6}(?:,\d{3})*(?![\d.,]*\d)\s+(?:[a-z]+\s+){0,2}(?:prs?|pull requests?|commits?|issues?|tickets?|reviews?|comments?|pages?|meetings?|bugs?|tests?|merges?|files?|releases?|changes?|tasks?|days?)\b/i;

const isTldr = (st: Statement) =>
  /^(\*\*)?tl;?dr\b/i.test(st.text) || (st.section != null && /^tl;?dr$/i.test(st.section));

const clip = (s: string) => (s.length > 120 ? `${s.slice(0, 117)}…` : s);

export function validateReport(bodyMd: string, known: KnownRefs): ValidationResult {
  const statements = statementsOf(bodyMd);
  const errors: ValidationError[] = [];
  const refs: ValidationResult['refs'] = [];

  if (!statements.length) {
    errors.push({
      code: 'empty_report',
      hint: 'The body has no statements. Write at least one cited bullet.',
    });
  }

  for (const st of statements) {
    const at = { anchor: st.anchor, line: st.line, text: clip(stripCitations(st.text)) };
    for (const bad of malformedCitations(st.text)) {
      errors.push({
        ...at,
        code: 'malformed_ref',
        ref: bad,
        hint: 'Citations look like [[r:<recordRevisionId>]], [[w:<id>]], [[v:<versionId>#<anchor>]] or [[s:<metric>]].',
      });
    }

    // A lead-in ("Opened PRs for beta.1 prep:") is covered by its cited sub-bullets; so is a
    // TL;DR, which summarizes cited points.
    const leadIn = st.children.length > 0 && st.children.every((c) => c.citations.length > 0);
    if (!st.citations.length && !leadIn && !isTldr(st)) {
      errors.push({
        ...at,
        code: 'unreferenced_statement',
        hint: 'Cite the evidence for this statement, e.g. [[r:<recordRevisionId>]] from the inputs, or remove it.',
      });
    }

    for (const c of st.citations) {
      refs.push({ anchor: st.anchor, citation: c });
      if (c.type === 'r') {
        const r = known.revisions.get(c.id);
        if (!r) {
          errors.push({
            ...at,
            code: 'unknown_ref',
            ref: c.raw,
            hint: 'No such record revision in the inputs. Use an ID from the bundle.',
          });
        } else if (!r.visibleToAudience) {
          errors.push({
            ...at,
            code: 'invisible_ref',
            ref: c.raw,
            hint: 'Not every reader of this report may see that record. Leave it out.',
          });
        } else if (
          r.applicableDate < known.period.start ||
          r.applicableDate >= known.period.endExcl
        ) {
          errors.push({
            ...at,
            code: 'out_of_period',
            ref: c.raw,
            hint: `That record belongs to ${r.applicableDate}, outside ${known.period.start}…${known.period.endExcl} (exclusive).`,
          });
        }
      } else if (c.type === 'v') {
        const anchors = known.versions.get(c.id);
        if (!anchors || (c.anchor && !anchors.has(c.anchor))) {
          errors.push({
            ...at,
            code: 'unknown_ref',
            ref: c.raw,
            hint: 'Cite an input report version and one of its statement anchors.',
          });
        }
      } else if (c.type === 'w') {
        if (!known.workItems.has(c.id)) {
          errors.push({
            ...at,
            code: 'unknown_ref',
            ref: c.raw,
            hint: 'No such work item in the inputs.',
          });
        }
      } else if (!known.stats.has(c.id)) {
        errors.push({
          ...at,
          code: 'unknown_stat',
          ref: c.raw,
          hint: 'Use a metric from the inputs’ stats.',
        });
      }
    }

    if (COUNT_RE.test(stripCitations(st.text)) && !st.citations.some((c) => c.type === 's')) {
      errors.push({
        ...at,
        code: 'number_without_stat',
        hint: 'Counts come from stats: cite one, e.g. "Merged 12 PRs [[s:prs_merged]]", or drop the number.',
      });
    }
  }
  return { ok: errors.length === 0, errors, statements, refs };
}
