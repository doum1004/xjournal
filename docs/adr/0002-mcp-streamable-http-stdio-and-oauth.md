# ADR 0002: MCP over stateless Streamable HTTP, a stdio proxy, and OAuth 2.1 via Better Auth

**Status:** Accepted, 2026-11-08 (M0 spike 2)
**Versions:** `@modelcontextprotocol/sdk` 1.32.2, `hono` 4.13.17, `@better-auth/mcp` 1.7.18 (+ `@better-auth/oauth-provider`, `better-auth/plugins` `jwt`), Claude Code 2.1.319

## Context

Spec §10.1 and `api.md` §5: the hub serves MCP itself over Streamable HTTP at `/mcp`, with a `hub-mcp` stdio proxy for stdio-only clients. Local mode authenticates with the per-install token; hosted mode with OAuth 2.1 + PKCE as in the MCP authorization spec. Spec §11.4 rule 1: no per-request state in the hub's memory.

## Decision

- **Server** (`apps/server/src/mcp.ts`): the SDK's `WebStandardStreamableHTTPServerTransport`, which takes a `Request` and returns a `Response`, mounted in Hono. **Stateless**: no MCP session ID, JSON responses, and a fresh `McpServer` per request. Any hub instance can serve any request.
- **Local mode**: `Authorization: Bearer <HUB_LOCAL_TOKEN>`, compared in constant time; 401 problem+json otherwise.
- **Proxy** (`apps/mcp-proxy`, `hub-mcp`): forwards raw JSON-RPC between `StdioServerTransport` and `StreamableHTTPClientTransport`. It knows nothing about tools, so it never needs updating when tools change. If the hub is unreachable, it answers requests with a JSON-RPC error instead of hanging.
- **Hosted mode**: Better Auth's `mcp()` plugin as the authorization server (OAuth 2.1, PKCE S256, RFC 8707 resource indicators, RFC 7591 dynamic registration, RFC 9728 protected-resource metadata), with access tokens as JWTs bound to the `/mcp` audience. `/mcp` is wrapped in `requireMcpAuth`, and the tool handler receives the token's `sub` as the acting user.

## Evidence

Automated (`apps/server/test/mcp.test.ts`, `auth.test.ts`, on PGlite and Postgres 17):
- SDK client over HTTP: `initialize`, `tools/list` (`whoami` has `readOnlyHint: true`), `tools/call`. A wrong token is rejected.
- The same through `hub-mcp` launched as a child process.
- Hosted: `/mcp` without a token → 401 with `WWW-Authenticate: … resource_metadata=…`; protected-resource metadata → authorization-server metadata (S256 advertised) → dynamic registration of a public client with a loopback redirect → authorize (signed-in passkey session) → consent → code + verifier → JWT → `tools/call whoami` returns `{via: 'oauth', userId: <the passkey user>}`. Stored refresh tokens are hashed.

Manual, with real Claude Code (`claude -p … --mcp-config <file> --strict-mcp-config`):

```json
{ "mcpServers": { "xjournal": { "type": "http", "url": "http://localhost:7420/mcp",
    "headers": { "Authorization": "Bearer <HUB_LOCAL_TOKEN>" } } } }
```
```json
{ "mcpServers": { "xjournal": { "type": "stdio", "command": "bun",
    "args": ["<repo>/apps/mcp-proxy/src/main.ts"],
    "env": { "HUB_URL": "http://localhost:7420/mcp", "HUB_TOKEN": "<HUB_LOCAL_TOKEN>" } } } }
```
Both returned `{"via":"local","userId":null,"scopes":["read","write"]}` from `whoami`.

## Consequences

- Dynamic registration must default to `clientRegistrationDefaultApplicationType: 'infer'`. Without it, Better Auth treats clients that omit `application_type` as web clients and rejects loopback `http://127.0.0.1/…` callbacks, which is what MCP clients such as Claude Code register.
- `requireMcpAuth` verifies tokens against the JWKS at `<baseURL>/api/auth/jwks`, **fetched over HTTP**. jose caches it, but the hub must be able to reach its own `HUB_BASE_URL`. If that's a problem behind Caddy, switch to `createMcpProtectedRequestHandler` with an internal `jwksUrl`.
- Unauthenticated dynamic registration is on, as MCP clients expect. It needs a rate limit before the hub is exposed (M7).
- Stateless mode means no server-to-client notifications outside a request. Nothing in `api.md` §5 needs them.

## Open items

- Real Claude Code against the hosted OAuth flow needs an HTTPS deployment plus the sign-in and consent pages (M7). The protocol path is covered by the automated test above.
- Personal access tokens (`access_tokens`) as `/mcp` bearer tokens, with the token's user as actor: M3.
- The acting user in local mode is `null` until the single local user exists (M1 `hub init`).
