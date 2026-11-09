import { describe, expect, test } from 'bun:test';
import {
  type ConfluenceConfig,
  cellOf,
  monthTitle,
  monthTitlesFor,
  rowsOf,
  scanConfluenceWorklog,
  storageToText,
} from '../src';

// Synthetic storage XHTML in the shape of the work-log month pages. Never real data.
const jira = (key: string) =>
  '<ac:structured-macro ac:name="jira" ac:schema-version="1">' +
  '<ac:parameter ac:name="server">Tracker</ac:parameter>' +
  `<ac:parameter ac:name="key">${key}</ac:parameter></ac:structured-macro>`;

const row = (date: string, cell: string) =>
  `<tr><td><div class="content-wrapper"><p><time datetime="${date}" /> </p></div></td>` +
  `<td><div class="content-wrapper">${cell}</div></td></tr>`;

const page = (rows: string[]) =>
  `<p>Daily Logs</p><table class="relative-table wrapped"><colgroup><col /><col /></colgroup><tbody>` +
  `<tr><th>Date</th><th>Logs</th></tr>${rows.join('')}</tbody></table>`;

describe('storageToText', () => {
  test('lists, nesting, bold, code, links, Jira macros and entities', () => {
    const s =
      '<ul><li><p>Reviewed <strong>release</strong> plan for ' +
      jira('PROJ-12') +
      '</p><ul><li>Asked about <code>retry()</code> &amp; timeouts</li></ul></li>' +
      '<li><a href="https://git.example.test/acme/sdk/pull/5">PR 5</a> merged&nbsp;today</li></ul>';
    expect(storageToText(s)).toBe(
      [
        '- Reviewed **release** plan for [PROJ-12]',
        '  - Asked about `retry()` & timeouts',
        '- PR 5 <https://git.example.test/acme/sdk/pull/5> merged today',
      ].join('\n'),
    );
  });

  test('headings move down one level; paragraphs and breaks become lines', () => {
    expect(storageToText('<h2>Meetings</h2><p>Standup</p><p>Line one<br/>line two</p>')).toBe(
      '### Meetings\nStandup\nLine one\nline two',
    );
  });

  test('macro parameters are hidden; CDATA bodies are kept; empty bold is dropped', () => {
    const s =
      '<ac:structured-macro ac:name="code"><ac:parameter ac:name="language">ts</ac:parameter>' +
      '<ac:plain-text-body><![CDATA[const x = 1;]]></ac:plain-text-body></ac:structured-macro>' +
      '<p><strong></strong></p><p>&#8211; done &#x2713;</p>';
    expect(storageToText(s)).toBe('const x = 1;\n– done ✓');
  });

  test('a stray < in text is kept', () => {
    expect(storageToText('<p>a < b</p>')).toBe('a < b');
  });
});

describe('month pages', () => {
  test('month titles, including the month before the range', () => {
    expect(monthTitle('2026-11-04')).toBe('November, 2026');
    expect(monthTitlesFor('2026-01-15', '2026-03-01')).toEqual([
      'December, 2025',
      'January, 2026',
      'February, 2026',
      'March, 2026',
    ]);
  });

  test('rows: the dated log cell as text; empty and undated rows skipped', () => {
    const body = page([
      row('2026-01-05', '<ul><li>Planned the quarter</li></ul>'),
      row('2026-01-06', '<p></p>'),
      '<tr><td>notes</td><td><p>no date</p></td></tr>',
      row('2026-01-07', `<p>Fixed ${jira('OPS-7')}</p>`),
    ]);
    expect(rowsOf(body)).toEqual([
      { date: '2026-01-05', text: '- Planned the quarter' },
      { date: '2026-01-07', text: 'Fixed [OPS-7]' },
    ]);
  });

  test('cellOf takes the second cell without its wrapper', () => {
    expect(cellOf(row('2026-01-05', '<p>x</p>'))).toBe('<p>x</p>');
  });
});

describe('scanConfluenceWorklog', () => {
  const pages: Record<string, { id: string; body: string; version: number }> = {
    'December, 2025': { id: '10', version: 3, body: page([row('2026-01-02', '<p>Late row</p>')]) },
    'January, 2026': {
      id: '11',
      version: 7,
      body: page([
        row('2025-12-31', '<p>Out of range</p>'),
        row('2026-01-02', '<p>Same day, second page</p>'),
        row('2026-01-05', '<ul><li>Planned the quarter</li></ul>'),
      ]),
    },
  };
  const calls: { url: string; auth: string | null }[] = [];
  const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push({ url: String(input), auth: new Headers(init?.headers).get('authorization') });
    const p = pages[url.searchParams.get('title') ?? ''];
    const results = p
      ? [
          {
            id: p.id,
            title: url.searchParams.get('title'),
            version: { number: p.version },
            body: { storage: { value: p.body } },
            _links: { webui: `/display/WL/${p.id}` },
          },
        ]
      : [];
    return Response.json({ results });
  }) as typeof fetch;
  const cfg: ConfluenceConfig = {
    baseUrl: 'https://wiki.example.test/',
    spaceKey: 'WL',
    token: 'tok',
    fetch: fakeFetch,
  };

  test('reads the month pages and builds one record per day', async () => {
    const scan = await scanConfluenceWorklog(cfg, { from: '2026-01-01', to: '2026-01-31' }, 'UTC');
    expect(scan.pagesRead).toEqual(['December, 2025', 'January, 2026']);
    expect(scan.pagesMissing).toEqual([]);
    expect(scan.records.map((r) => [r.input.externalId, r.input.title])).toEqual([
      ['2026-01-02', 'Late row'],
      ['2026-01-05', 'Planned the quarter'],
    ]);
    const first = scan.records[0];
    expect(first?.source).toBe('confluence:worklog');
    // Rows for one date on two pages are joined, in page order.
    expect(first?.input.payload?.text).toBe('Late row\nSame day, second page');
    expect(first?.input.url).toBe('https://wiki.example.test/display/WL/10');
    expect(first?.input.payload?.page).toEqual({ id: '10', title: 'December, 2025', version: 3 });

    expect(new URL(calls[0]?.url as string).searchParams.get('spaceKey')).toBe('WL');
    expect(calls[0]?.auth).toBe('Bearer tok');
  });

  test('missing pages are reported; Basic auth when a user is given', async () => {
    calls.length = 0;
    const scan = await scanConfluenceWorklog(
      { ...cfg, user: 'me' },
      { from: '2026-02-01', to: '2026-02-28' },
      'UTC',
    );
    expect(scan.pagesMissing).toEqual(['February, 2026']);
    expect(scan.pagesRead).toEqual(['January, 2026']);
    expect(calls[0]?.auth).toBe(`Basic ${Buffer.from('me:tok').toString('base64')}`);
  });

  test('HTTP errors and bad ranges throw', async () => {
    const failing = {
      ...cfg,
      fetch: (async () => new Response('no', { status: 401 })) as unknown as typeof fetch,
    };
    await expect(
      scanConfluenceWorklog(failing, { from: '2026-01-01', to: '2026-01-02' }, 'UTC'),
    ).rejects.toThrow('HTTP 401');
    await expect(
      scanConfluenceWorklog(cfg, { from: '2026-02-01', to: '2026-01-01' }, 'UTC'),
    ).rejects.toThrow();
  });
});
