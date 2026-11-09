import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';

export interface McpCaller {
  /** 'local': the per-install token. 'oauth': an MCP OAuth access token (hosted). */
  via: 'local' | 'oauth';
  userId: string | null;
  scopes: string[];
  clientId?: string;
}

export const MCP_SERVER_INFO = { name: 'xjournal', version: '0.0.0' } as const;

/**
 * One MCP server per request, in stateless Streamable HTTP mode: no MCP session lives in
 * the hub's memory, so any instance can serve any request (spec §11.4 rule 1).
 * M0 registers a single read tool to prove the plumbing; api.md §5 tools arrive in M3.
 */
function buildServer(caller: McpCaller): McpServer {
  const server = new McpServer(MCP_SERVER_INFO, {
    instructions: 'xjournal activity and knowledge hub. M0 spike: only `whoami` is available.',
  });
  server.registerTool(
    'whoami',
    {
      title: 'Who am I',
      description: 'Returns the identity this MCP connection acts as. Read-only.',
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => ({
      content: [{ type: 'text', text: JSON.stringify(caller) }],
      structuredContent: { ...caller },
    }),
  );
  return server;
}

export async function handleMcp(request: Request, caller: McpCaller): Promise<Response> {
  const server = buildServer(caller);
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  try {
    return await transport.handleRequest(request);
  } finally {
    // JSON responses are complete once handleRequest resolves.
    await transport.close().catch(() => {});
    await server.close().catch(() => {});
  }
}
