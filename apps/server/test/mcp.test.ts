import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { DbHandle } from '@xjournal/db';
import { createTestDb } from '@xjournal/db/testing';
import { createApp } from '../src/app';

// Spike 2 (docs/adr/0002), local mode: Streamable HTTP with the per-install token, and the
// hub-mcp stdio proxy in front of it. (The hosted OAuth flow is in auth.test.ts.)

const TOKEN = 'local-test-token-0123456789abcdef';
let h: DbHandle;
let server: ReturnType<typeof Bun.serve>;
let url: URL;

beforeAll(async () => {
  h = await createTestDb();
  const app = createApp({
    config: {
      mode: 'local',
      localToken: TOKEN,
      authSecret: 'unused-unused-unused-unused-unused',
      baseURL: 'http://localhost',
    },
    db: h,
  });
  server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: app.fetch });
  url = new URL(`http://127.0.0.1:${server.port}/mcp`);
});

afterAll(async () => {
  server?.stop(true);
  await h?.close();
});

async function exercise(client: Client) {
  const { tools } = await client.listTools();
  const whoami = tools.find((t) => t.name === 'whoami');
  expect(whoami?.annotations?.readOnlyHint).toBe(true);
  const result = await client.callTool({ name: 'whoami', arguments: {} });
  expect(result.structuredContent).toMatchObject({ via: 'local', userId: null });
}

describe('MCP, local mode', () => {
  test('Streamable HTTP with the per-install token', async () => {
    const client = new Client({ name: 'test', version: '0' });
    await client.connect(
      new StreamableHTTPClientTransport(url, {
        requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } },
      }),
    );
    expect(client.getServerVersion()?.name).toBe('xjournal');
    await exercise(client);
    await client.close();
  });

  test('a wrong token is rejected', async () => {
    const client = new Client({ name: 'test', version: '0' });
    await expect(
      client.connect(
        new StreamableHTTPClientTransport(url, {
          requestInit: { headers: { Authorization: 'Bearer nope' } },
        }),
      ),
    ).rejects.toThrow();
  });

  test('through the hub-mcp stdio proxy', async () => {
    const proxy = fileURLToPath(new URL('../../mcp-proxy/src/main.ts', import.meta.url));
    const client = new Client({ name: 'stdio-test', version: '0' });
    await client.connect(
      new StdioClientTransport({
        command: process.execPath, // bun
        args: [proxy],
        env: { ...process.env, HUB_URL: url.toString(), HUB_TOKEN: TOKEN } as Record<
          string,
          string
        >,
        stderr: 'ignore',
      }),
    );
    await exercise(client);
    await client.close();
  }, 20_000);
});

// biome-ignore lint/suspicious/noExplicitAny: tool results are JSON
type AnyJson = any;

describe('MCP tools: the morning run, end to end', () => {
  const call = async (
    client: Client,
    name: string,
    args: Record<string, unknown>,
  ): Promise<AnyJson> => {
    const r = await client.callTool({ name, arguments: args });
    if (r.isError) throw new Error(JSON.stringify(r.content));
    return r.structuredContent;
  };

  test('status → inputs → save (with a validation retry) → read', async () => {
    const { initLocal, createProject, ingestRecords } = await import('@xjournal/services');
    const { owner } = await initLocal(h.db, { name: 'Robin', timeZone: 'UTC' });
    const c = { db: h.db, actor: owner };
    const p = await createProject(c, { slug: 'sdk', name: 'SDK' });
    const yesterday = new Date(Date.now() - 86_400_000);
    // The most recent weekday before today, so it's "due".
    while ([0, 6].includes(yesterday.getUTCDay())) yesterday.setUTCDate(yesterday.getUTCDate() - 1);
    const day = yesterday.toISOString().slice(0, 10);
    await ingestRecords(c, {
      source: 'test',
      tier: 'file_import',
      projectId: p.id,
      records: [
        {
          externalId: 'a',
          kind: 'note',
          eventTime: `${day}T12:00:00Z`,
          applicableDate: day,
          title: 'Fixed the CI secret',
          actor: 'me',
        },
      ],
    });

    const client = new Client({ name: 'test', version: '0' });
    await client.connect(
      new StreamableHTTPClientTransport(url, {
        requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } },
      }),
    );
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(
      [
        'add_guidance',
        'add_note',
        'get_day',
        'get_report',
        'get_report_inputs',
        'get_stats',
        'get_status',
        'ingest_records',
        'list_inbox',
        'route_note',
        'save_report',
        'search',
        'whoami',
      ].sort(),
    );
    expect(tools.find((t) => t.name === 'save_report')?.annotations?.destructiveHint).toBe(false);
    const { prompts } = await client.listPrompts();
    expect(prompts.map((x) => x.name).sort()).toEqual(['capture', 'morning_run', 'period_review']);
    const prompt = await client.getPrompt({ name: 'morning_run', arguments: {} });
    expect(JSON.stringify(prompt.messages)).toContain('get_status');

    const status = await call(client, 'get_status', {});
    expect(status.due).toContainEqual({
      kind: 'daily',
      date: day,
      projectId: p.id,
      reason: 'missing',
    });

    const inputs = await call(client, 'get_report_inputs', {
      kind: 'daily',
      date: day,
      projectId: 'sdk',
    });
    const rec = inputs.bundles[0].unlinked[0];
    expect(rec.title).toBe('Fixed the CI secret');

    const bad = await call(client, 'save_report', {
      reportId: inputs.report.reportId,
      bodyMd: '## CI\n- Fixed the CI secret',
      inputHash: inputs.inputHash,
    });
    expect(bad.saved).toBe(false);
    expect(bad.validation[0].code).toBe('unreferenced_statement');

    const saved = await call(client, 'save_report', {
      reportId: inputs.report.reportId,
      bodyMd: `## CI\n- Fixed the CI secret [[r:${rec.revisionId}]]`,
      inputHash: inputs.inputHash,
      client: 'test-agent',
    });
    expect(saved).toMatchObject({ versionNo: 1, client: 'test-agent', status: 'current' });

    const read = await call(client, 'get_report', { kind: 'daily', date: day });
    expect(read.citations[0]).toMatchObject({
      type: 'record_revision',
      title: 'Fixed the CI secret',
    });
    const after = await call(client, 'get_status', {});
    expect(
      after.due.some((d: { date: string; kind: string }) => d.kind === 'daily' && d.date === day),
    ).toBe(false);

    const unknown = await client.callTool({
      name: 'get_day',
      arguments: { date: day, projectId: 'nope' },
    });
    expect(unknown.isError).toBe(true);
    await client.close();
  });
});
