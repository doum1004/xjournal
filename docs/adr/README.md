# Architecture decision records

Short records of decisions that are expensive to reverse, and of the M0 spikes (`plan.md` §2) that confirmed or replaced the planned stack.

| ADR | Decision | Status |
|---|---|---|
| [0001](0001-better-auth-passkeys-and-invites.md) | Better Auth for passkeys, invite link + code, device approval | Accepted (spike 1 confirmed, with schema deviations) |
| [0002](0002-mcp-streamable-http-stdio-and-oauth.md) | MCP over stateless Streamable HTTP in Hono, `hub-mcp` stdio proxy, OAuth 2.1 via Better Auth | Accepted (spike 2 confirmed) |
| [0003](0003-pg-boss-and-drizzle-on-bun.md) | pg-boss and Drizzle (node-postgres) on Bun; no Node fallback | Accepted (spike 3 confirmed) |
| [0004](0004-pglite-parity.md) | PGlite 0.4.x (Postgres 17) for tests, parity-checked against Docker Postgres 17 | Accepted (spike 4 confirmed) |
| [0005](0005-rls-roles-and-helpers.md) | RLS with two group roles (`hub_app`, `hub_auth`) and SECURITY DEFINER helpers | Accepted |
| [0006](0006-bundles-sync-and-the-morning-run.md) | Pure connectors with a resumable sync runner; system-built bundles kept stale-aware by a trigger; the pg-boss morning run | Accepted (M2) |
| [0007](0007-reports-citations-and-staleness.md) | Hub-assembled report inputs with one hash; citation tokens checked by a pure validator; computed staleness and due lists; the prototype import and the Confluence guard | Accepted (M3) |

Format: context, decision, evidence, consequences, open items. Add a new ADR rather than rewriting an accepted one; mark the old one superseded.
