import { sha256Hex } from '@xjournal/core';

// Statements and citations in a report body (api.md §4.2). A statement is a bullet (with its
// wrapped continuation lines) or a paragraph; headings, tables, code and rules aren't. Every
// statement gets an anchor derived from its text without citations, so an unchanged bullet
// keeps its anchor across versions.

export type CitationType = 'r' | 'w' | 'v' | 's';
export interface Citation {
  type: CitationType;
  id: string;
  /** For `v:`: the statement anchor inside the input report version. */
  anchor?: string;
  raw: string;
}

const CITATION_RE = /\[\[([rwvs]):([^\]\s#]+)(?:#([^\]\s]+))?\]\]/g;

export function citationsIn(text: string): Citation[] {
  const out: Citation[] = [];
  for (const m of text.matchAll(CITATION_RE)) {
    out.push({
      type: m[1] as CitationType,
      id: m[2] as string,
      ...(m[3] ? { anchor: m[3] } : {}),
      raw: m[0],
    });
  }
  return out;
}

export const stripCitations = (text: string) =>
  text
    .replace(CITATION_RE, '')
    .replace(/[ \t]+$/gm, '')
    .replace(/ {2,}/g, ' ');

/** Matches any `[[…]]` token, to catch malformed citations. */
const ANY_TOKEN_RE = /\[\[[^\]]*\]\]/g;
export const malformedCitations = (text: string) =>
  [...text.matchAll(ANY_TOKEN_RE)]
    .map((m) => m[0])
    .filter((t) => !t.match(/^\[\[([rwvs]):([^\]\s#]+)(?:#([^\]\s]+))?\]\]$/));

export interface Statement {
  anchor: string;
  /** The statement's text, citations included. */
  text: string;
  kind: 'bullet' | 'paragraph';
  /** Bullet nesting depth (0 = top level). */
  depth: number;
  /** The heading it sits under, if any. */
  section: string | null;
  /** 1-based line number in the body. */
  line: number;
  /** Bullets nested directly under this one. */
  children: Statement[];
  citations: Citation[];
}

const BULLET_RE = /^(\s*)(?:[-*+]|\d+[.)])\s+(.*)$/;
const HEADING_RE = /^\s{0,3}#{1,6}\s+(.*)$/;

const normalize = (t: string) => stripCitations(t).replace(/\s+/g, ' ').trim().toLowerCase();

/** Split a Markdown body into statements, with stable anchors. */
export function statementsOf(body: string): Statement[] {
  const lines = body.replace(/\r\n?/g, '\n').split('\n');
  const out: Statement[] = [];
  let section: string | null = null;
  let inCode = false;
  let inFront = lines[0]?.trim() === '---';
  let current: Statement | null = null;
  const stack: Statement[] = []; // open bullets, by depth

  const close = () => {
    current = null;
  };

  lines.forEach((raw, i) => {
    const lineNo = i + 1;
    if (inFront) {
      if (i > 0 && raw.trim() === '---') inFront = false;
      return;
    }
    if (/^\s*(```|~~~)/.test(raw)) {
      inCode = !inCode;
      close();
      return;
    }
    if (inCode) return;
    if (!raw.trim()) {
      close();
      return;
    }
    const h = raw.match(HEADING_RE);
    if (h) {
      section = (h[1] ?? '').trim();
      stack.length = 0;
      close();
      return;
    }
    if (/^\s*\|/.test(raw) || /^\s*([-*_])\s*\1\s*\1[\s\-*_]*$/.test(raw)) {
      close(); // table rows and horizontal rules
      return;
    }
    const b = raw.match(BULLET_RE);
    if (b) {
      const indent = (b[1] ?? '').replace(/\t/g, '    ').length;
      const depth = Math.floor(indent / 2);
      const st: Statement = {
        anchor: '',
        text: (b[2] ?? '').trim(),
        kind: 'bullet',
        depth,
        section,
        line: lineNo,
        children: [],
        citations: [],
      };
      while (stack.length && (stack.at(-1) as Statement).depth >= depth) stack.pop();
      stack.at(-1)?.children.push(st);
      stack.push(st);
      out.push(st);
      current = st;
      return;
    }
    const cur = current as Statement | null;
    if (cur) {
      cur.text = `${cur.text} ${raw.trim()}`; // a wrapped line continues the statement
      return;
    }
    stack.length = 0;
    const st: Statement = {
      anchor: '',
      text: raw.trim(),
      kind: 'paragraph',
      depth: 0,
      section,
      line: lineNo,
      children: [],
      citations: [],
    };
    out.push(st);
    current = st;
  });

  const used = new Map<string, number>();
  for (const st of out) {
    st.citations = citationsIn(st.text);
    const base = `s${sha256Hex(`${st.section ?? ''}\n${normalize(st.text)}`).slice(0, 10)}`;
    const n = used.get(base) ?? 0;
    used.set(base, n + 1);
    st.anchor = n ? `${base}-${n + 1}` : base;
  }
  return out;
}
