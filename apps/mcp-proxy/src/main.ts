#!/usr/bin/env bun
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

/**
 * hub-mcp: a stdio ↔ Streamable HTTP proxy (spec §10.1) for agent clients that only launch
 * stdio servers. It forwards JSON-RPC messages unchanged, so every tool call still goes
 * through the hub's service layer and its authorization.
 *
 *   HUB_URL    the hub's MCP endpoint (default http://localhost:7420/mcp)
 *   HUB_TOKEN  the local per-install token, or a personal access token
 *
 * stdout carries the protocol; diagnostics go to stderr.
 */

const url = new URL(process.env.HUB_URL ?? 'http://localhost:7420/mcp');
const token = process.env.HUB_TOKEN;
const log = (msg: string) => process.stderr.write(`[hub-mcp] ${msg}\n`);

const upstream = new StreamableHTTPClientTransport(url, {
  requestInit: token ? { headers: { Authorization: `Bearer ${token}` } } : undefined,
});
const downstream = new StdioServerTransport();

downstream.onmessage = (message) => {
  upstream.send(message).catch((err: unknown) => {
    log(`upstream error: ${err instanceof Error ? err.message : String(err)}`);
    // Answer the request so the client doesn't hang.
    if ('id' in message && message.id !== undefined && 'method' in message) {
      void downstream.send({
        jsonrpc: '2.0',
        id: message.id,
        error: { code: -32603, message: `hub unreachable at ${url.origin}` },
      });
    }
  });
};
upstream.onmessage = (message) => {
  void downstream.send(message);
};
upstream.onerror = (err) => log(`upstream: ${err.message}`);
downstream.onerror = (err) => log(`stdio: ${err.message}`);

const close = async () => {
  await Promise.allSettled([upstream.close(), downstream.close()]);
  process.exit(0);
};
downstream.onclose = close;
process.on('SIGINT', close);
process.on('SIGTERM', close);

await upstream.start();
await downstream.start();
log(`proxying stdio to ${url}`);
