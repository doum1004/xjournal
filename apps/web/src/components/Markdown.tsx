import type { CitationView } from '@xjournal/core';
import { Fragment, type ReactNode } from 'react';

// A small Markdown renderer for report bodies: headings, nested lists, paragraphs, links,
// **bold**, `code`, and citations ([[r:…]] [[v:…#…]] [[s:…]]) as numbered links to their
// source. It builds React elements, so nothing is injected as HTML.

const TOKEN_RE =
  /\[\[([rwvs]):([^\]\s#]+)(?:#([^\]\s]+))?\]\]|\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)|<(https?:\/\/[^>\s]+)>|\*\*(.+?)\*\*|`([^`]+)`/g;

interface Ctx {
  byId: Map<string, CitationView>;
  numbers: Map<string, number>;
}

function citationLink(
  type: string,
  id: string,
  anchor: string | undefined,
  c: Ctx,
  key: string,
): ReactNode {
  const refId = anchor ? `${id}#${anchor}` : id;
  let n = c.numbers.get(refId);
  if (n == null) {
    n = c.numbers.size + 1;
    c.numbers.set(refId, n);
  }
  const cit = c.byId.get(refId);
  const title =
    cit?.title ??
    (type === 's' ? `stat: ${id}` : type === 'v' ? 'a statement of an input report' : refId);
  const cls = 'ml-0.5 align-super text-[10px] text-accent no-underline hover:underline';
  if (type === 'v') {
    return (
      <a key={key} href={`/reports/${id}`} title={title} className={cls}>
        [{n}]
      </a>
    );
  }
  return cit?.url ? (
    <a
      key={key}
      href={cit.url}
      target="_blank"
      rel="noreferrer noopener"
      title={title}
      className={cls}
    >
      [{n}]
    </a>
  ) : (
    <span key={key} title={title} className={`${cls} cursor-help`}>
      [{n}]
    </span>
  );
}

function inline(text: string, c: Ctx, keyBase: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let i = 0;
  for (const m of text.matchAll(TOKEN_RE)) {
    const at = m.index ?? 0;
    if (at > last) out.push(text.slice(last, at));
    const key = `${keyBase}-${i++}`;
    if (m[1]) out.push(citationLink(m[1], m[2] as string, m[3], c, key));
    else if (m[4]) {
      out.push(
        <a
          key={key}
          href={m[5]}
          target="_blank"
          rel="noreferrer noopener"
          className="text-accent underline underline-offset-2"
        >
          {m[4]}
        </a>,
      );
    } else if (m[6]) {
      out.push(
        <a
          key={key}
          href={m[6]}
          target="_blank"
          rel="noreferrer noopener"
          className="break-all text-accent underline underline-offset-2"
        >
          {m[6]}
        </a>,
      );
    } else if (m[7]) out.push(<strong key={key}>{inline(m[7], c, key)}</strong>);
    else if (m[8]) {
      out.push(
        <code key={key} className="rounded bg-bg px-1 font-mono text-[0.9em]">
          {m[8]}
        </code>,
      );
    }
    last = at + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

interface Item {
  text: string;
  children: Item[];
}

type Block =
  | { type: 'h'; level: number; text: string }
  | { type: 'p'; text: string }
  | { type: 'ul'; items: Item[] };

function parse(md: string): Block[] {
  const lines = md
    .replace(/\r\n?/g, '\n')
    .replace(/^---\n[\s\S]*?\n---\n/, '')
    .split('\n');
  const blocks: Block[] = [];
  let list: { items: Item[]; stack: { indent: number; item: Item }[] } | null = null;
  let para: string[] = [];
  const flushPara = () => {
    if (para.length) blocks.push({ type: 'p', text: para.join(' ') });
    para = [];
  };
  const flushList = () => {
    if (list) blocks.push({ type: 'ul', items: list.items });
    list = null;
  };
  for (const raw of lines) {
    if (!raw.trim()) {
      flushPara();
      flushList();
      continue;
    }
    const h = raw.match(/^\s{0,3}(#{1,6})\s+(.*)$/);
    if (h) {
      flushPara();
      flushList();
      blocks.push({ type: 'h', level: (h[1] ?? '').length, text: h[2] ?? '' });
      continue;
    }
    const b = raw.replace(/\t/g, '  ').match(/^(\s*)(?:[-*+]|\d+[.)])\s+(.*)$/);
    if (b) {
      flushPara();
      const indent = (b[1] ?? '').length;
      const item: Item = { text: b[2] ?? '', children: [] };
      list ??= { items: [], stack: [] };
      const l = list as { items: Item[]; stack: { indent: number; item: Item }[] };
      while (l.stack.length && (l.stack.at(-1)?.indent ?? 0) >= indent) l.stack.pop();
      const parent = l.stack.at(-1);
      if (parent) parent.item.children.push(item);
      else l.items.push(item);
      l.stack.push({ indent, item });
      continue;
    }
    // An indented line continues the bullet above; an unindented one ends the list.
    const open = list as { stack: { item: Item }[] } | null;
    const last = open?.stack.at(-1);
    if (last && /^\s/.test(raw)) {
      last.item.text = `${last.item.text} ${raw.trim()}`;
      continue;
    }
    flushList();
    // A lone bold line ("**SDK**", the work log's area headings) stands on its own.
    if (/^\*\*[^*]+\*\*:?$/.test(raw.trim())) {
      flushPara();
      blocks.push({ type: 'h', level: 4, text: raw.trim().replace(/^\*\*|\*\*:?$/g, '') });
      continue;
    }
    para.push(raw.trim());
  }
  flushPara();
  flushList();
  return blocks;
}

function List({ items, c, k }: { items: Item[]; c: Ctx; k: string }) {
  return (
    <ul className="ml-5 list-disc space-y-1">
      {items.map((it, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: a static rendering of one body
        <li key={`${k}-${i}`}>
          {inline(it.text, c, `${k}-${i}`)}
          {it.children.length > 0 && <List items={it.children} c={c} k={`${k}-${i}`} />}
        </li>
      ))}
    </ul>
  );
}

export function Markdown({ body, citations = [] }: { body: string; citations?: CitationView[] }) {
  const c: Ctx = { byId: new Map(citations.map((x) => [x.id, x])), numbers: new Map() };
  return (
    <div className="space-y-2 text-sm leading-relaxed">
      {parse(body).map((b, i) => {
        const k = `b${i}`;
        if (b.type === 'h') {
          return (
            <h3
              key={k}
              className={`${b.level <= 2 ? 'mt-3 text-base' : 'mt-2 text-sm'} font-semibold`}
            >
              {inline(b.text, c, k)}
            </h3>
          );
        }
        if (b.type === 'p') return <p key={k}>{inline(b.text, c, k)}</p>;
        return (
          <Fragment key={k}>
            <List items={b.items} c={c} k={k} />
          </Fragment>
        );
      })}
    </div>
  );
}
