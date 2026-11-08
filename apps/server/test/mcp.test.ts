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
