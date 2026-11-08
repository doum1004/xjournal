# ADR 0005: Row-level security with two group roles and SECURITY DEFINER helpers

**Status:** Accepted, 2026-11-08 (M0)

## Context

`schema.md` §9 defines RLS keyed on `app.user_id` and `app.workspace_id`, forced on every table, and tested from the MVP even though local mode has one user (spec §16.2 rule 5). Sign-in (Better Auth, invite redemption) runs before a user is known, so it can't use those policies.

## Decision

**Roles** (created by `packages/db/drizzle/0001_rls.sql`; both `NOLOGIN`, and the login role in `DATABASE_URL` must be a member):

| Role | Used by | Can reach |
|---|---|---|
| `hub_app` | The service layer, through `withActor(db, {userId, workspaceId}, fn)` | Hub tables, under the policies below. No grants on library-owned auth tables. No UPDATE/DELETE on append-only tables. No DELETE on `records`. |
| `hub_auth` | Better Auth's pool (`connectPostgres(url, {role: 'hub_auth'})`) and invite redemption (`withAuthRole`) | Only the sign-in tables (`users`, `sessions`, `passkeys`, `accounts`, `verifications`, `jwks`, `oauth_*`), plus reading and consuming `invites`, inserting `project_members` and reading `projects`. It can't read records, connectors, tokens or workspaces. |

`withActor` sets the role and both settings with `SET LOCAL` / `set_config(…, true)` inside a transaction, so a pooled connection never carries one user's identity into the next request.

**Helpers** (`app_role`, `app_is_member`, `app_can_see_record`, …) are `SECURITY DEFINER` with a fixed `search_path`. That lets the `project_members` policy ask "is the caller a member?" without recursing into itself. One function, `app_record_visible`, holds the record read rule, and both the `records` policy and its child tables use it.

**Tests:** `packages/db/test/rls.test.ts` has one test per policy. Its last test fails if any table lacks enabled **and** forced RLS, or if any policy in `pg_policies` wasn't exercised.

## Where the policies go beyond `schema.md` §9

`schema.md` §9 is a summary; these are the interpretations made while writing the SQL. They have been folded back into `schema.md` §9:

- **Workspace owner:** can read every project in the workspace and add the first members of a new project (otherwise nobody could seed a project's owner row).
- **Leaving:** a member may update their own `project_members` row (to set `left_at`) but never raise their role. The check compares against the caller's current role.
- **Restricted records** also require current membership of the project, so leaving a project hides its restricted items too.
- **Revisions** are visible according to their record's *current* visibility, not the visibility stored on the revision. Making a note private hides its history as well.
- **`users`:** yourself, plus anyone who shares an active project with you. Only `hub_auth` inserts users.
- **`workspaces`:** policies added (owner and members read; the owner updates; insert only as owner).

## Consequences and open items

- The SECURITY DEFINER helpers must be owned by a role that bypasses RLS, because tables are `FORCE`d. In Docker and PGlite the migration role is a superuser, so this holds. **On a managed Postgres (stage 2, e.g. Azure Flexible Server) the admin is not a superuser.** Before moving there, either grant the owning role `BYPASSRLS` (if the service allows it), or have the helpers read through tables that aren't `FORCE`d for their owner. Tracked for M7.
- `record_embeddings` (`schema.md` §5) is deferred to M5: its vector size follows the embedding model, which isn't chosen yet (`plan.md` §3).
- Tables from `schema.md` §6–8 (work items, bundles, reports, guidance, comments, reminders, sharing, audit) get their policies in the milestones that add them, with the same one-test-per-policy guard.
