import { type NoteKind, noteKinds } from './enums';
import { addDays, isIsoDate } from './time';

// Inline hints in a note (spec §3.6): `#project`, `@date`, `!kind` or `!tag`.
// Hints override every other routing step. The raw text is always stored as written.

export interface NoteHints {
  /** Project slugs from `#slug`, in order, without duplicates. */
  projects: string[];
  /** From `@today`, `@yesterday` or `@YYYY-MM-DD`. */
  date?: string;
  /** From `!event`, `!context`, `!guidance` or `!reminder`. */
  kind?: NoteKind;
  /** Every other `!word`, lower-cased. */
  tags: string[];
  /** `@…` hints that couldn't be read as a date. */
  invalid: string[];
}

export interface ParsedNote {
  hints: NoteHints;
  /** The text with hints removed and whitespace tidied, used for the title and summary. */
  clean: string;
}

// A hint starts the text or follows whitespace, so `a#b`, emails and URLs aren't hints.
const HINT_RE = /(^|\s)([#@!])([\p{L}\p{N}][\p{L}\p{N}._/-]*)/gu;
const TRAILING_PUNCT_RE = /[.,;:]+$/;

/** Read the hints in `text`. `today` is the entered date in the routing time zone. */
export function parseNoteHints(text: string, today: string): ParsedNote {
  const hints: NoteHints = { projects: [], tags: [], invalid: [] };
  const clean = text.replace(HINT_RE, (match, lead: string, sigil: string, raw: string) => {
    const word = raw.replace(TRAILING_PUNCT_RE, '');
    const trailing = raw.slice(word.length);
    if (sigil === '#') {
      const slug = word.toLowerCase();
      if (!hints.projects.includes(slug)) hints.projects.push(slug);
      return lead + trailing;
    }
    if (sigil === '@') {
      const date = resolveDate(word.toLowerCase(), today);
      if (!date) {
        // Not a date (e.g. an @mention): leave it in the text.
        hints.invalid.push(word);
        return match;
      }
      hints.date = date;
      return lead + trailing;
    }
    const tag = word.toLowerCase();
    if ((noteKinds as readonly string[]).includes(tag)) hints.kind = tag as NoteKind;
    else if (!hints.tags.includes(tag)) hints.tags.push(tag);
    return lead + trailing;
  });
  return { hints, clean: tidy(clean) };
}

function resolveDate(word: string, today: string): string | undefined {
  if (word === 'today') return today;
  if (word === 'yesterday') return addDays(today, -1);
  if (isIsoDate(word)) return word;
  return undefined;
}

function tidy(text: string): string {
  return (
    text
      .split('\n')
      // Removing a hint can leave "fix ." behind; close that gap.
      .map((line) =>
        line
          .replace(/[ \t]+/g, ' ')
          .replace(/ ([.,;:!?])(?=\s|$)/g, '$1')
          .trim(),
      )
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  );
}

export const TITLE_MAX = 300;
export const SUMMARY_MAX = 2000;

/** Title (first non-empty line) and summary (the whole text, when longer) for a note. */
export function noteTitleAndSummary(
  clean: string,
  raw: string,
): { title: string; summary?: string } {
  const source = clean || raw.trim();
  const firstLine = source.split('\n').find((l) => l.trim()) ?? '(empty note)';
  const title = truncate(firstLine.trim(), TITLE_MAX);
  const summary = source.length > title.length ? truncate(source, SUMMARY_MAX) : undefined;
  return summary ? { title, summary } : { title };
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}
