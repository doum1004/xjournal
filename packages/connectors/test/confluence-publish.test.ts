import { describe, expect, test } from 'bun:test';
import {
  markdownToStorage,
  placeRow,
  publishWorklogDay,
  rowHtml,
  storageToText,
  TABLE_HEAD,
  type WorklogTarget,
} from '../src';

/** An in-memory Confluence with just the content endpoints the publisher uses. */
function fakeConfluence(initial: Record<string, string> = {}) {
  let nextId = 100;
  const pages = new Map<
    string,
    { id: string; title: string; version: number; body: string; parent?: string }
  >();
  for (const [title, body] of Object.entries(initial))
    pages.set(title, { id: String(nextId++), title, version: 1, body });
  const f = (async (u: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(u instanceof Request ? u.url : String(u));
    const method = init.method ?? 'GET';
    if (method === 'GET' && url.pathname === '/rest/api/content') {
      const p = pages.get(url.searchParams.get('title') ?? '');
      return Response.json({
        results: p
          ? [
              {
                id: p.id,
                title: p.title,
                version: { number: p.version },
                body: { storage: { value: p.body } },
                _links: { webui: `/pages/${p.id}` },
              },
            ]
          : [],
      });
    }
    const body = JSON.parse(String(init.body ?? '{}'));
    if (method === 'POST' && url.pathname === '/rest/api/content') {
      const p = {
        id: String(nextId++),
        title: body.title,
        version: 1,
        body: body.body.storage.value,
        parent: body.ancestors[0].id,
      };
      pages.set(p.title, p);
      return Response.json({ id: p.id });
    }
    const m = url.pathname.match(/^\/rest\/api\/content\/(\d+)$/);
    if (method === 'PUT' && m) {
      const p = [...pages.values()].find((x) => x.id === m[1]);
      if (!p) return new Response('nope', { status: 404 });
      if (body.version.number !== p.version + 1)
        return new Response('version conflict', { status: 409 });
      p.version = body.version.number;
      p.body = body.body.storage.value;
      return Response.json({ id: p.id });
    }
    return new Response('unexpected', { status: 500 });
  }) as typeof fetch;
  return { f, pages };
}

const target = (f: typeof fetch): WorklogTarget => ({
  baseUrl: 'https://wiki.example.test',
  spaceKey: '~me',
  token: 'tok',
  rootPageId: '1',
  jira: { server: 'Jira', serverId: 'abc' },
  fetch: f,
});

describe('markdownToStorage', () => {
  test('headings as bold paragraphs, nested lists, links, Jira macros, escaping', () => {
    const md =
      '## SDK\n- Fixed [PIX-12] in `ci.yml` <https://x.test/1>\n  - See [the PR](https://x.test/2) & more\n- **Done**';
    const s = markdownToStorage(md, { server: 'Jira', serverId: 'abc' });
    expect(s).toBe(
      '<p><strong>SDK</strong></p><ul><li>Fixed <ac:structured-macro ac:name="jira" ac:schema-version="1"><ac:parameter ac:name="server">Jira</ac:parameter><ac:parameter ac:name="serverId">abc</ac:parameter><ac:parameter ac:name="key">PIX-12</ac:parameter></ac:structured-macro> in <code>ci.yml</code> <a href="https://x.test/1">https://x.test/1</a><ul><li>See <a href="https://x.test/2">the PR</a> &amp; more</li></ul></li><li><strong>Done</strong></li></ul>',
    );
    expect(storageToText(s)).toContain('[PIX-12]');
  });

  test('rows go in date order and replace their date', () => {
    let body = TABLE_HEAD;
    body = placeRow(body, '2026-11-05', '<p>five</p>');
    body = placeRow(body, '2026-11-03', '<p>three</p>');
    body = placeRow(body, '2026-11-05', '<p>FIVE</p>');
    const dates = [...body.matchAll(/datetime="([\d-]+)"/g)].map((m) => m[1]);
    expect(dates).toEqual(['2026-11-03', '2026-11-05']);
    expect(body).toContain('FIVE');
    expect(body).not.toContain('>five<');
  });
});

describe('publishWorklogDay', () => {
  test('creates the year and month pages, then the row', async () => {
    const c = fakeConfluence();
    const r = await publishWorklogDay(target(c.f), {
      date: '2026-11-04',
      markdown: '## SDK\n- Fixed it',
      lastHash: null,
    });
    expect(r).toMatchObject({ status: 'published', pageTitle: 'November, 2026' });
    expect(c.pages.get('Work Logs - 2026')?.parent).toBe('1');
    expect(c.pages.get('November, 2026')?.parent).toBe(c.pages.get('Work Logs - 2026')?.id);
    expect(c.pages.get('November, 2026')?.body).toContain('Fixed it');
  });

  test('republishing our own row is fine; a row edited in Confluence is refused unless forced', async () => {
    const c = fakeConfluence({ 'November, 2026': TABLE_HEAD });
    const first = await publishWorklogDay(target(c.f), {
      date: '2026-11-04',
      markdown: '- One',
      lastHash: null,
    });
    if (first.status !== 'published') throw new Error('expected published');
    const second = await publishWorklogDay(target(c.f), {
      date: '2026-11-04',
      markdown: '- Two',
      lastHash: first.contentHash,
    });
    expect(second.status).toBe('published');
    if (second.status !== 'published') return;

    // Someone edits the row by hand.
    const page = c.pages.get('November, 2026');
    if (!page) throw new Error('no page');
    page.body = page.body.replace('Two', 'Two, plus a manual line');
    page.version++;
    const refused = await publishWorklogDay(target(c.f), {
      date: '2026-11-04',
      markdown: '- Three',
      lastHash: second.contentHash,
    });
    expect(refused).toMatchObject({ status: 'refused', currentText: '- Two, plus a manual line' });
    expect(page.body).toContain('manual line');

    const forced = await publishWorklogDay(target(c.f), {
      date: '2026-11-04',
      markdown: '- Three',
      lastHash: second.contentHash,
      force: true,
    });
    expect(forced.status).toBe('published');
    expect(page.body).toContain('Three');
  });

  test('a row written before the hub (no recorded hash) is refused', async () => {
    const c = fakeConfluence({
      'November, 2026': placeRow(TABLE_HEAD, '2026-11-02', '<p>typed by hand</p>'),
    });
    const r = await publishWorklogDay(target(c.f), {
      date: '2026-11-02',
      markdown: '- New',
      lastHash: null,
    });
    expect(r.status).toBe('refused');
    // An empty row is not "content": it's filled.
    const empty = fakeConfluence({
      'November, 2026': TABLE_HEAD.replace('</tbody>', `${rowHtml('2026-11-02', '')}</tbody>`),
    });
    expect(
      (
        await publishWorklogDay(target(empty.f), {
          date: '2026-11-02',
          markdown: '- New',
          lastHash: null,
        })
      ).status,
    ).toBe('published');
  });
});
