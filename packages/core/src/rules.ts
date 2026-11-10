import { z } from 'zod';
import { zRecordKind } from './schemas';

// Project assignment rules (spec §8.4). A rule's `match` is a set of conditions that must all
// hold; `*` in a pattern matches any run of characters, and patterns ignore case. The fields
// read the record's source key, kind, title and the payload keys the built-in connectors set:
// `repo` (GitHub), `project` (Jira), `space` (Confluence), `channel` (Slack, no "#").

const zPattern = z.string().trim().min(1).max(200);

export const zRuleMatch = z
  .object({
    source: zPattern.optional(),
    repo: zPattern.optional(),
    project: zPattern.optional(),
    space: zPattern.optional(),
    channel: zPattern.optional(),
    kinds: z.array(zRecordKind).min(1).optional(),
    titleContains: z.string().trim().min(1).max(200).optional(),
  })
  .strict()
  .refine(
    (m) => Object.values(m).some((v) => v !== undefined),
    'a rule needs at least one condition',
  );
export type RuleMatch = z.infer<typeof zRuleMatch>;

export interface RuleSubject {
  source: string;
  kind: string;
  title: string;
  payload?: Record<string, unknown> | null;
}

const globCache = new Map<string, RegExp>();
export function globMatches(pattern: string, value: string): boolean {
  let re = globCache.get(pattern);
  if (!re) {
    const body = pattern
      .split('*')
      .map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
      .join('.*');
    re = new RegExp(`^${body}$`, 'i');
    globCache.set(pattern, re);
  }
  return re.test(value);
}

export function ruleMatches(m: RuleMatch, r: RuleSubject): boolean {
  const field = (k: string) => {
    const v = r.payload?.[k];
    return typeof v === 'string' ? v : null;
  };
  const test = (pattern: string | undefined, value: string | null) =>
    pattern === undefined || (value != null && globMatches(pattern, value));
  return (
    test(m.source, r.source) &&
    test(m.repo, field('repo')) &&
    test(m.project, field('project')) &&
    test(m.space, field('space')) &&
    test(m.channel?.replace(/^#/, ''), field('channel')) &&
    (m.kinds === undefined || m.kinds.includes(r.kind as never)) &&
    (m.titleContains === undefined || r.title.toLowerCase().includes(m.titleContains.toLowerCase()))
  );
}

/** The first matching rule, by priority (lowest first) then age. */
export function firstMatch<R extends { priority: number; match: RuleMatch }>(
  rules: R[],
  r: RuleSubject,
): R | undefined {
  return [...rules].sort((a, b) => a.priority - b.priority).find((x) => ruleMatches(x.match, r));
}
