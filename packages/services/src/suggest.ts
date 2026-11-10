import type { SyncLog } from '@xjournal/connectors';
import { type ActiveItem, bundleRepo, type HubDb, withSystem, workItemRepo } from '@xjournal/db';
import type { SecretStore } from '@xjournal/secrets';
import { z } from 'zod';
import { messageOf } from './connectors';
import { ANTHROPIC_KEY_REF } from './generate';
import { SKIP_KINDS, SKIP_NOTE_KINDS } from './workitems';
import { claudeWriter, type ReportWriter } from './writer';

// AI-suggested work item links (spec §3.5, docs/adr/0009). After the rules have linked what
// records say about themselves, the model is asked where the rest belong: a commit on a
// branch, a Slack thread about the feature without the issue key, a meeting named after the
// work. Its answers are stored as `origin = 'ai'` links with a confidence, and reports mark
// them. Each record is asked about once per revision; a rule link later supersedes a guess.

/** Matching is classification, not writing: a smaller model does it well. */
export const LINK_MODEL = 'claude-sonnet-5-5';
/** Guesses below this are dropped. */
export const MIN_CONFIDENCE = 0.6;
/** Records per model call. */
const BATCH = 40;
/** How far back to look, in days, for records and for the items they may belong to. */
const DEFAULT_DAYS = 14;

export interface SuggestDeps {
  secrets: SecretStore;
  /** The model call; default: the Claude API with the stored key. */
  writer?: (apiKey: string, model: string) => ReportWriter;
  model?: string;
  log?: SyncLog;
}

export interface SuggestSummary {
  /** 'no_key': no Claude API key is stored, so nothing was asked. */
  status: 'ok' | 'no_key';
  /** Projects with records to ask about. */
  projects: number;
  /** Records the model was asked about. */
  asked: number;
  /** Links it suggested at or above MIN_CONFIDENCE. */
  linked: number;
  /** Records in batches that failed; they are asked again next time. */
  failed: number;
}

export interface Candidate {
  id: string;
  revisionId: string;
  source: string;
  kind: string;
  noteKind?: string | null;
  title: string;
  summary?: string | null;
  eventTime: Date;
}

export interface Suggestion {
  workItemId: string;
  recordId: string;
  confidence: number;
}

/** Records the rules leave out are left out here too, for the same reasons. */
export const askable = (c: Candidate) =>
  !SKIP_KINDS.has(c.kind) && !(c.noteKind && SKIP_NOTE_KINDS.has(c.noteKind));

export const SUGGEST_SYSTEM = `You place work records into the work items they belong to. A work item is one piece of work: a Jira issue or a pull request, with the records already linked to it. The records you are given mention no issue key or pull request link, so the match has to come from what they are about.

Link a record to an item only when it is clearly about the same piece of work: the same feature, bug, change or document. Sharing a repository, a team or a general area is not enough. Leave a record out when unsure; most records belong to no item.

Confidence: 0.9 when the record names the same specific change, 0.7 when it very likely is the same work, lower otherwise. At most one item per record.

Answer with JSON only, no prose and no code fences:
{"links":[{"record":"r1","item":"w2","confidence":0.8}]}
An empty answer is {"links":[]}.`;

const clip = (s: string, n: number) => {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

/** The user message: items as w1…, records as r1…, so the model never copies an ID. */
export function suggestPrompt(items: ActiveItem[], records: Candidate[]): string {
  const out = ['## Work items'];
  items.forEach((w, i) => {
    out.push(`w${i + 1}: ${clip(w.title, 200)}`);
    for (const t of w.records) out.push(`  - ${clip(t, 160)}`);
  });
  out.push('', '## Records');
  records.forEach((r, i) => {
    const summary = r.summary ? ` — ${clip(r.summary, 300)}` : '';
    out.push(
      `r${i + 1} (${r.eventTime.toISOString().slice(0, 10)}, ${r.source} ${r.kind}): ${clip(r.title, 200)}${summary}`,
    );
  });
  return out.join('\n');
}

const zAnswer = z.object({
  links: z.array(
    z.object({
      record: z.string(),
      item: z.string(),
      confidence: z.number().min(0).max(1),
    }),
  ),
});

/**
 * The model's answer as links. Unknown labels and low confidences are dropped; a record keeps
 * its most confident item. Throws when the answer isn't the JSON asked for.
 */
export function parseSuggestions(
  text: string,
  items: ActiveItem[],
  records: Candidate[],
): Suggestion[] {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error('the model did not answer with JSON');
  const answer = zAnswer.parse(JSON.parse(text.slice(start, end + 1)));
  const best = new Map<string, Suggestion>();
  for (const l of answer.links) {
    const r = records[Number(l.record.replace(/^r/, '')) - 1];
    const w = items[Number(l.item.replace(/^w/, '')) - 1];
    if (!r || !w || l.confidence < MIN_CONFIDENCE) continue;
    const prev = best.get(r.id);
    if (!prev || l.confidence > prev.confidence) {
      best.set(r.id, { workItemId: w.id, recordId: r.id, confidence: l.confidence });
    }
  }
  return [...best.values()];
}

/**
 * Ask the model where unlinked records of the last `days` belong, system-side, and store its
 * answers as AI links. Does nothing without a Claude API key. Safe to run at any time: records
 * already asked about at their current revision aren't asked again.
 */
export async function suggestWorkItemLinks(
  db: HubDb,
  deps: SuggestDeps,
  opts: { projectIds?: string[]; now?: Date; days?: number } = {},
): Promise<SuggestSummary> {
  const summary: SuggestSummary = { status: 'ok', projects: 0, asked: 0, linked: 0, failed: 0 };
  const key = await deps.secrets.get(ANTHROPIC_KEY_REF);
  if (!key) return { ...summary, status: 'no_key' };
  const writer = (deps.writer ?? claudeWriter)(key, deps.model ?? LINK_MODEL);
  const now = opts.now ?? new Date();
  const since = new Date(now.getTime() - (opts.days ?? DEFAULT_DAYS) * 86_400_000);

  const all = await withSystem(db, (tx) => bundleRepo.allProjects(tx));
  const projects = opts.projectIds ? all.filter((p) => opts.projectIds?.includes(p.id)) : all;
  for (const p of projects) {
    const { items, candidates } = await withSystem(db, async (tx) => ({
      items: await workItemRepo.activeItems(tx, p.id, since),
      candidates: (await workItemRepo.aiCandidates(tx, p.id, since)).filter(askable),
    }));
    // With no items there is nothing to place a record in; ask once some exist.
    if (!items.length || !candidates.length) continue;
    summary.projects++;
    for (let i = 0; i < candidates.length; i += BATCH) {
      const batch = candidates.slice(i, i + BATCH);
      let links: Suggestion[];
      try {
        const { text } = await writer.write({
          system: SUGGEST_SYSTEM,
          messages: [{ role: 'user', content: suggestPrompt(items, batch) }],
        });
        links = parseSuggestions(text, items, batch);
      } catch (e) {
        deps.log?.warn('work item suggestions failed', { project: p.slug, error: messageOf(e) });
        summary.failed += batch.length;
        continue;
      }
      summary.asked += batch.length;
      summary.linked += await withSystem(db, (tx) =>
        workItemRepo.saveAiLinks(
          tx,
          p.workspaceId,
          links,
          batch.map((c) => ({ recordId: c.id, revisionId: c.revisionId })),
          now,
        ),
      );
    }
  }
  return summary;
}
