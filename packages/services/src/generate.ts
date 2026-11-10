import type { RecordView, ReportInputs, ReportVersionView } from '@xjournal/core';
import type { SecretStore } from '@xjournal/secrets';
import { z } from 'zod';
import type { Ctx } from './context';
import { parse, ServiceError } from './errors';
import { getReportInputs, saveReportVersion } from './reports';
import { claudeWriter, DEFAULT_MODEL, type ReportWriter, type WriterMessage } from './writer';

// The direct generation path (spec §16.1, plan.md M4): the hub writes a report itself, from
// the same inputs and through the same validator as the agent path. Validation errors go
// back to the model to fix, a bounded number of times.

export const ANTHROPIC_KEY_REF = 'anthropic/api-key';
const MAX_ATTEMPTS = 3;

export interface GenerateDeps {
  secrets: SecretStore;
  /** The model call; default: the Claude API with the stored key. */
  writer?: (apiKey: string, model: string) => ReportWriter;
  model?: string;
}

export async function aiStatus(deps: GenerateDeps) {
  return {
    hasKey: (await deps.secrets.get(ANTHROPIC_KEY_REF)) != null,
    model: deps.model ?? DEFAULT_MODEL,
  };
}

export async function setApiKey(deps: GenerateDeps, input: unknown) {
  const { key } = parse(z.object({ key: z.string().trim().min(20).max(500) }), input);
  await deps.secrets.set(ANTHROPIC_KEY_REF, key);
}

export async function removeApiKey(deps: GenerateDeps) {
  await deps.secrets.delete(ANTHROPIC_KEY_REF);
}

const SYSTEM = `You write work reports for one person from evidence a hub collected for them (pull requests, reviews, commits, issues, wiki edits, meetings, notes). You write in their voice: first person implied, plain past tense, concise and specific.

Rules that always apply:
- Use only the evidence you are given. Never invent work, outcomes, people or numbers.
- Every bullet and paragraph ends with at least one citation token of the evidence it states, copied exactly from the inputs: [[r:<id>]] for a record, [[v:<versionId>#<anchor>]] for a statement of an input report, [[s:<metric>]] for a number. A lead-in bullet ending in ":" needs none if every bullet under it has one; the TL;DR line needs none.
- Numbers that count things come only from the stats, with their [[s:…]] token. Otherwise write no count.
- Group related evidence into one bullet per piece of work rather than one bullet per event, and cite all of it.
- Follow the template's sections and instructions, and the guidance, which takes precedence over the template.
- Output only the report's Markdown: no preamble, no code fences, no front matter.`;

function renderInputs(i: ReportInputs, instructions?: string): string {
  const out: string[] = [];
  out.push(
    `# Write: ${i.report.kind} report, ${i.report.period.title} (${i.report.period.start} to ${i.report.period.endExcl}, end exclusive)`,
  );
  out.push(
    '',
    '## Template',
    `Sections: ${i.template.sections.join(' · ')}`,
    '',
    i.template.instructions,
  );
  if (i.guidance.length) {
    out.push('', '## Guidance (most specific first; follow it)');
    for (const g of i.guidance) out.push(`- (${g.scope}) ${g.text}`);
  }
  if (instructions) out.push('', '## Extra instructions for this version', instructions);
  for (const b of i.bundles ?? []) {
    out.push('', `## Evidence for ${b.date} (cite as [[r:<id>]], work items as [[w:<id>]])`);
    const line = (r: RecordView) => {
      const summary = r.summary ? ` — ${r.summary.replace(/\s+/g, ' ').slice(0, 300)}` : '';
      const url = r.url ? ` <${r.url}>` : '';
      return `- [[r:${r.revisionId}]] ${r.kind}${r.isMine ? '' : ' (someone else)'}: ${r.title}${summary}${url}`;
    };
    for (const w of b.workItems) {
      out.push('', `### Work item [[w:${w.id}]] ${w.title}${w.url ? ` <${w.url}>` : ''}`);
      for (const r of w.records) out.push(line(r));
    }
    if (b.workItems.length && b.unlinked.length) out.push('', '### Other records');
    for (const r of b.unlinked) out.push(line(r));
    const cov = Object.values(b.coverage).filter((c) => c.status !== 'complete');
    if (cov.length)
      out.push('', `Coverage gaps: ${cov.map((c) => `${c.source} ${c.status}`).join('; ')}`);
  }
  if (i.workItems?.length) {
    out.push(
      '',
      '## Work items active in the period (each is one piece of work across sources; cite as [[w:<id>]])',
    );
    for (const w of i.workItems) {
      const kinds = Object.entries(w.kinds)
        .map(([k, n]) => `${n} ${k}`)
        .join(', ');
      out.push(
        `- [[w:${w.id}]] ${w.title}${w.url ? ` <${w.url}>` : ''} — ${w.days.join(', ')}; ${kinds}`,
      );
    }
  }
  for (const r of i.inputReports ?? []) {
    out.push(
      '',
      `## Input report: ${r.kind} ${r.period.start} (status ${r.status}; cite statements as [[v:${r.versionId}#<anchor>]])`,
    );
    for (const s of r.statements) out.push(`- #${s.anchor}: ${s.text}`);
  }
  if (i.previousPeriod) {
    const pp = i.previousPeriod;
    out.push(
      '',
      `## The previous ${i.report.kind} report, ${pp.period.title}: its plan, for plan vs. actual (cite as [[v:${pp.versionId}#<anchor>]])`,
    );
    for (const s of pp.statements) out.push(`- #${s.anchor}: ${s.text}`);
  }
  if (i.context?.length) {
    out.push('', '## Standing context (background; cite only if you state it)');
    for (const r of i.context) out.push(`- [[r:${r.revisionId}]] ${r.title}`);
  }
  out.push('', '## Stats (cite as [[s:<metric>]])');
  for (const s of i.stats) out.push(`- [[s:${s.metric}]] = ${s.value} (${s.description})`);
  if (i.gaps.missingDays.length)
    out.push('', `Days without a daily report: ${i.gaps.missingDays.join(', ')}`);
  if (i.gaps.missingInputs?.length)
    out.push(
      '',
      `Periods without an input report: ${i.gaps.missingInputs.map((m) => `${m.kind} ${m.title}`).join(', ')}`,
    );
  if (i.previous) {
    out.push(
      '',
      '## The previous version (keep what still holds; this is not evidence)',
      i.previous.bodyMd,
    );
  }
  return out.join('\n');
}

const unfence = (t: string) =>
  t
    .trim()
    .replace(/^```(?:markdown|md)?\n([\s\S]*?)\n```$/i, '$1')
    .trim();

export interface GenerateOptions {
  instructions?: string;
  now?: Date;
}

export async function generateReport(
  ctx: Ctx,
  deps: GenerateDeps,
  reportId: string,
  opts: GenerateOptions = {},
): Promise<ReportVersionView> {
  const key = await deps.secrets.get(ANTHROPIC_KEY_REF);
  if (!key) {
    throw new ServiceError(
      409,
      'conflict',
      'Direct generation is off: add a Claude API key in Settings → AI',
      undefined,
      {
        reason: 'direct_generation_disabled',
      },
    );
  }
  const model = deps.model ?? DEFAULT_MODEL;
  const writer = (deps.writer ?? claudeWriter)(key, model);
  let inputs = await getReportInputs(ctx, reportId, opts.now);
  let messages: WriterMessage[] = [
    { role: 'user', content: renderInputs(inputs, opts.instructions) },
  ];
  let lastErrors: unknown = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const { text, model: used } = await writer.write({ system: SYSTEM, messages });
    const body = unfence(text);
    try {
      return await saveReportVersion(
        ctx,
        reportId,
        {
          bodyMd: body,
          inputHash: inputs.inputHash,
          ...(inputs.previous
            ? {
                changeSummary: opts.instructions
                  ? `Regenerated: ${opts.instructions}`
                  : 'Regenerated from the current inputs',
              }
            : {}),
          generator: { path: 'direct', client: 'xjournal', model: used },
        },
        opts.now,
      );
    } catch (e) {
      if (!(e instanceof ServiceError)) throw e;
      if (e.code === 'validation_failed') {
        lastErrors = e.data?.validation;
        messages = [
          ...messages,
          { role: 'assistant', content: body },
          {
            role: 'user',
            content: `The hub rejected that version. Fix exactly these problems and output the whole corrected report again (Markdown only):\n${JSON.stringify(lastErrors, null, 1)}`,
          },
        ];
        continue;
      }
      if (e.code === 'stale_input') {
        // The evidence moved while writing: start over from the new inputs.
        inputs = await getReportInputs(ctx, reportId, opts.now);
        messages = [{ role: 'user', content: renderInputs(inputs, opts.instructions) }];
        continue;
      }
      throw e;
    }
  }
  throw new ServiceError(
    422,
    'validation_failed',
    `The model could not produce a valid report in ${MAX_ATTEMPTS} attempts`,
    undefined,
    {
      validation: lastErrors,
    },
  );
}

/** The due reports of a project (or all), resolved to report IDs, oldest first. */
export async function dueReportIds(ctx: Ctx, projectId?: string, now: Date = new Date()) {
  const { getStatus } = await import('./status');
  const { resolveReport } = await import('./reports');
  const st = await getStatus(ctx, { ...(projectId ? { projectId } : {}), now });
  const out: { reportId: string; kind: string; date: string }[] = [];
  for (const d of st.due) {
    const r = await resolveReport(ctx, { projectId: d.projectId, kind: d.kind, date: d.date });
    out.push({ reportId: r.reportId, kind: d.kind, date: d.date });
  }
  return out;
}

export interface RefreshResult {
  written: { kind: string; date: string; versionId: string }[];
  failed: { kind: string; date: string; error: string }[];
}

/** `POST /projects/{p}/reports/refresh` without a job queue: write every due report in turn. */
export async function refreshReports(
  ctx: Ctx,
  deps: GenerateDeps,
  projectId?: string,
  now: Date = new Date(),
): Promise<RefreshResult> {
  const result: RefreshResult = { written: [], failed: [] };
  for (const d of await dueReportIds(ctx, projectId, now)) {
    try {
      const v = await generateReport(ctx, deps, d.reportId, { now });
      result.written.push({ kind: d.kind, date: d.date, versionId: v.versionId });
    } catch (e) {
      result.failed.push({
        kind: d.kind,
        date: d.date,
        error: e instanceof Error ? e.message : String(e),
      });
      if (
        e instanceof ServiceError &&
        (e.data?.reason === 'direct_generation_disabled' || e.status === 400)
      )
        break;
    }
  }
  return result;
}
