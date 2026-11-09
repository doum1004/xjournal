import { type CareerEntryView, newId, zIsoDate } from '@xjournal/core';
import {
  type CareerEntryRow,
  careerRepo,
  projectRepo,
  type ReportRow,
  type ReportVersionRow,
  type Tx,
} from '@xjournal/db';
import { periodFor, stripCitations } from '@xjournal/reports';
import { z } from 'zod';
import { asCaller, type Ctx } from './context';
import { conflict, forbidden, isUniqueViolation, notFound, parse } from './errors';

// The career log (spec §9.8): the quarterly report proposes public-safe accomplishment bullets
// under "## Career log"; they land here as a draft the user edits and approves. Entries are
// private to their owner, and they leave the hub only through the user's own export.

const SECTION_RE = /^##\s+career log\s*$/i;

/** The "## Career log" section of a report body, without citations; null when absent. */
export function careerSection(bodyMd: string): string | null {
  const lines = bodyMd.replace(/\r\n?/g, '\n').split('\n');
  const at = lines.findIndex((l) => SECTION_RE.test(l.trim()));
  if (at < 0) return null;
  const out: string[] = [];
  for (const line of lines.slice(at + 1)) {
    if (/^#{1,2}\s/.test(line)) break;
    out.push(stripCitations(line).replace(/\s+$/, ''));
  }
  const text = out.join('\n').trim();
  return text || null;
}

// What a public profile must not carry (spec §9.8). Deterministic and deliberately eager: a
// warning asks the user to look, it never blocks.
const CHECKS: { re: RegExp; reason: string }[] = [
  { re: /\[\[[rwvs]:[^\]]*\]\]/, reason: 'a citation token' },
  { re: /\b[A-Z][A-Z0-9]{1,9}-\d+\b/, reason: 'an issue key' },
  { re: /https?:\/\/|<[a-z]+:\/\/|\bwww\./i, reason: 'a link' },
  { re: /\b\d{1,3}(?:\.\d{1,3}){3}\b/, reason: 'an IP address' },
  {
    re: /\b[\w-]+(?:\.[\w-]+)*\.(?:internal|corp|local|lan|intra|cds)\b/i,
    reason: 'an internal hostname',
  },
  { re: /\b[\w.-]+\/[\w.-]+\.git\b|\bgithub\.[\w.]+\/[\w.-]+/i, reason: 'a repository' },
  {
    re: /[$€£¥]\s?\d|\b\d[\d,.]*\s?(?:k|m|bn|million|billion)?\s?(?:usd|eur|dollars?)\b|\b(?:revenue|arr|budget|salary)\b/i,
    reason: 'a financial figure',
  },
  {
    re: /\b\d+\s+(?:engineers?|people|employees|hires?|ftes?|headcount|contractors?)\b|\bheadcount\b|\blay-?offs?\b/i,
    reason: 'a headcount figure',
  },
  {
    re: /\b(?:unreleased|unannounced|confidential|internal only|under nda|roadmap)\b/i,
    reason: 'unreleased or confidential plans',
  },
];

export function publicSafeWarnings(text: string): CareerEntryView['warnings'] {
  const out: CareerEntryView['warnings'] = [];
  text.split('\n').forEach((line, i) => {
    for (const c of CHECKS) {
      const m = line.match(c.re);
      if (m) out.push({ line: i + 1, text: m[0], reason: c.reason });
    }
  });
  return out;
}

const quarterTitle = (start: string) => periodFor('quarterly', start).title;

function toView(r: CareerEntryRow): CareerEntryView {
  return {
    id: r.id,
    projectId: r.projectId,
    periodStart: r.periodStart,
    title: quarterTitle(r.periodStart),
    bodyMd: r.bodyMd,
    status: r.status as CareerEntryView['status'],
    sourceVersionId: r.sourceVersionId,
    approvedAt: r.approvedAt?.toISOString() ?? null,
    updatedAt: r.updatedAt.toISOString(),
    warnings: publicSafeWarnings(r.bodyMd),
  };
}

/**
 * After a quarterly version is saved: its "## Career log" becomes the quarter's draft, or
 * replaces the draft there. An approved entry is the user's own text and is left alone.
 */
export async function proposeCareerEntry(
  tx: Tx,
  ctx: Ctx,
  report: ReportRow,
  version: ReportVersionRow,
): Promise<'created' | 'updated' | 'kept' | 'none'> {
  if (report.kind !== 'quarterly' || !report.projectId) return 'none';
  if (report.audienceKey !== `me:${ctx.actor.userId}`) return 'none'; // a personal log only
  const body = careerSection(version.bodyMd);
  if (!body) return 'none';
  const key = {
    userId: ctx.actor.userId,
    projectId: report.projectId,
    periodStart: report.periodStart,
  };
  const existing = await careerRepo.findEntry(tx, key);
  if (existing?.status === 'approved') return 'kept';
  if (existing) {
    await careerRepo.updateEntry(tx, existing.id, {
      bodyMd: body,
      sourceVersionId: version.id,
      updatedAt: new Date(),
    });
    return 'updated';
  }
  await careerRepo.insertEntry(tx, {
    id: newId(),
    workspaceId: ctx.actor.workspaceId,
    ...key,
    bodyMd: body,
    sourceVersionId: version.id,
  });
  return 'created';
}

export async function listCareer(ctx: Ctx, projectId?: string): Promise<CareerEntryView[]> {
  return asCaller(ctx, async (tx) => (await careerRepo.listEntries(tx, projectId)).map(toView));
}

export const zCareerCreate = z.object({
  projectId: z.string().min(1),
  /** Any date in the quarter. */
  date: zIsoDate,
  bodyMd: z.string().trim().min(1).max(20_000),
});

/** `POST /career`: write a quarter's entry by hand (a draft). */
export async function createCareerEntry(ctx: Ctx, input: unknown): Promise<CareerEntryView> {
  const req = parse(zCareerCreate, input);
  const id = newId();
  return asCaller(ctx, async (tx) => {
    if (!(await projectRepo.findProject(tx, req.projectId))) throw notFound('Project not found');
    try {
      await careerRepo.insertEntry(tx, {
        id,
        workspaceId: ctx.actor.workspaceId,
        projectId: req.projectId,
        userId: ctx.actor.userId,
        periodStart: periodFor('quarterly', req.date).start,
        bodyMd: req.bodyMd,
      });
    } catch (e) {
      if (isUniqueViolation(e)) throw conflict('That quarter already has an entry: edit it');
      throw e;
    }
    return toView((await careerRepo.getEntry(tx, id)) as CareerEntryRow);
  });
}

export const zCareerPatch = z
  .object({
    bodyMd: z.string().trim().min(1).max(20_000).optional(),
    status: z.enum(['draft', 'approved']).optional(),
  })
  .refine((v) => v.bodyMd !== undefined || v.status !== undefined, 'nothing to change');

/**
 * `PATCH /career/{id}`: edit and approve. Editing an approved entry without approving again
 * puts it back to draft, so what's approved is always what the user last read.
 */
export async function updateCareerEntry(
  ctx: Ctx,
  id: string,
  input: unknown,
): Promise<CareerEntryView> {
  const patch = parse(zCareerPatch, input);
  return asCaller(ctx, async (tx) => {
    const cur = await careerRepo.getEntry(tx, id);
    if (!cur) throw notFound('Career log entry not found');
    const changed = patch.bodyMd !== undefined && patch.bodyMd !== cur.bodyMd;
    const status = patch.status ?? (changed ? 'draft' : cur.status);
    const ok = await careerRepo.updateEntry(tx, id, {
      ...(patch.bodyMd !== undefined ? { bodyMd: patch.bodyMd } : {}),
      status,
      approvedAt: status === 'approved' ? new Date() : null,
      updatedAt: new Date(),
    });
    if (!ok) throw forbidden('That entry is not yours');
    return toView((await careerRepo.getEntry(tx, id)) as CareerEntryRow);
  });
}

export async function deleteCareerEntry(ctx: Ctx, id: string): Promise<void> {
  const ok = await asCaller(ctx, (tx) => careerRepo.deleteEntry(tx, id));
  if (!ok) throw notFound('Career log entry not found');
}

export const zCareerExport = z.object({
  projectId: z.string().min(1).optional(),
  /** Include drafts too (default: approved only). */
  drafts: z
    .union([z.boolean(), z.enum(['true', 'false'])])
    .transform((v) => v === true || v === 'true')
    .default(false),
});

/** `GET /career/export`: the log as Markdown, newest quarter first, for a profile or a CV. */
export async function exportCareer(
  ctx: Ctx,
  input: unknown,
): Promise<{ filename: string; markdown: string; count: number }> {
  const q = parse(zCareerExport, input);
  const entries = (await listCareer(ctx, q.projectId))
    .filter((e) => q.drafts || e.status === 'approved')
    .reverse();
  // Several projects may share a quarter: one section per quarter.
  const byQuarter = new Map<string, string[]>();
  for (const e of entries) {
    const list = byQuarter.get(e.title) ?? [];
    list.push(e.bodyMd.trim());
    byQuarter.set(e.title, list);
  }
  const sections = [...byQuarter].map(([title, bodies]) => `## ${title}\n${bodies.join('\n')}`);
  return {
    filename: 'career-log.md',
    markdown: `${['# Career log', ...sections].join('\n\n')}\n`,
    count: entries.length,
  };
}

/** The prototype's `career/experience.md`: one "## Qn YYYY" section per quarter. */
export function parseExperience(text: string): { date: string; bodyMd: string }[] {
  const out: { date: string; bodyMd: string }[] = [];
  let cur: { date: string; lines: string[] } | null = null;
  const flush = () => {
    const body = cur?.lines.join('\n').trim();
    if (cur && body) out.push({ date: cur.date, bodyMd: body });
  };
  for (const line of text.replace(/\r\n?/g, '\n').split('\n')) {
    const m = line.match(/^##\s+Q([1-4])\s+(\d{4})\s*$/);
    if (m) {
      flush();
      cur = { date: `${m[2]}-${String(Number(m[1]) * 3 - 2).padStart(2, '0')}-01`, lines: [] };
    } else if (/^#{1,2}\s/.test(line)) {
      flush();
      cur = null;
    } else cur?.lines.push(line);
  }
  flush();
  return out;
}

/**
 * Import the prototype's career log as approved entries (the user reviewed them when they
 * were written). Quarters that already have an entry are left alone.
 */
export async function importCareer(
  ctx: Ctx,
  projectId: string,
  text: string,
): Promise<{ created: number; skipped: number }> {
  const result = { created: 0, skipped: 0 };
  await asCaller(ctx, async (tx) => {
    if (!(await projectRepo.findProject(tx, projectId))) throw notFound('Project not found');
    for (const q of parseExperience(text)) {
      const key = { userId: ctx.actor.userId, projectId, periodStart: q.date };
      if (await careerRepo.findEntry(tx, key)) {
        result.skipped++;
        continue;
      }
      await careerRepo.insertEntry(tx, {
        id: newId(),
        workspaceId: ctx.actor.workspaceId,
        ...key,
        bodyMd: q.bodyMd,
        status: 'approved',
        approvedAt: new Date(),
      });
      result.created++;
    }
  });
  return result;
}
