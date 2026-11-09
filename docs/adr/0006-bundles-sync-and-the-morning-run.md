# ADR 0006: Connector sync, daily bundles and the morning run

**Status:** Accepted, 2026-11-09 (M2)

## Context

M2 (`plan.md` §2) adds built-in connectors and daily bundles that reports will cite (spec §4, §5.1, §8). Three things had to be decided: how a sync stays resumable and idempotent, how a bundle learns that its inputs changed, and who builds bundles when RLS hides some records from every single user.

## Decision

**Connectors are pure.** A connector (`packages/connectors/src/sdk.ts`) gets its config, credential, identities and one stream's cursor, and returns a page of `RecordInput`s plus the next cursor. It never touches the database. The sync runner (`packages/services/src/sync.ts`) owns credentials, cursors, identities ("is this mine?"), routing, dedup and status.

- **Resumable:** each page's records and its cursor are written in one transaction, so an interrupted sync resumes exactly where it stopped.
- **Idempotent:** records dedupe on `(source, external_id)` and content hash. Connectors overlap their windows on purpose (an hour for the GitHub feed, a day for JQL/CQL, a week for GitHub search), so a late edit is picked up and nothing at a boundary is lost.
- **Failures are per stream:** one stream's error doesn't stop the others; a refused credential (`ConnectorAuthError`) does. Errors are redacted of the credential before they're stored or logged.
- **Credentials** live in the OS keychain (`Bun.secrets`) locally; the database keeps only `secret_ref`.

**Routing order** for a new connector record: the first matching project rule (spec §8.4), else the account's project when it feeds exactly one, else the Inbox.

**Bundles are built by a system job** (`withSystem`: the migration role, which bypasses RLS), because a bundle covers every record of its project and date (schema.md §6) and no user can see them all. `hub_app` can only read bundles, under policies that hide items whose record the caller can't see.

**Staleness is marked by a trigger** on `records`, not by the services. Any change to a record's day, project, current revision or hidden state marks the bundles of its old and new day dirty, so no write path can forget to. Days with records and no bundle count as stale too.

**Coverage has no timestamps.** Per connector and day it's `complete`, `pending`, `error` or `truncated`. A day's hash changes when its evidence or its coverage status changes, and then never again, so reports built on a finished day don't go stale for no reason.

**The morning run** (`morningRun`) syncs every connected account as its owner, then rebuilds the last 14 days and every stale day. pg-boss runs it on a cron in the workspace time zone (default 07:00), on an `exclusive` queue with a singleton key, and also runs "sync now" jobs, one per account at a time.

## Evidence

- `packages/services/test/sync.test.ts`, `bundles.test.ts`, `rules.test.ts`; `packages/connectors/test/*`; `packages/db/test/rls.test.ts` (the bundle policies and the trigger); `apps/server/test/jobs.test.ts` (`startJobs`).
- A real sync of two GitHub accounts (GHE and github.com) on 2026-11-09, compared with the prototype's `raw/2026-11-06.json`: every PR opened, merged and reviewed in the digest is in the hub, plus merges the digest missed. It also found that GitHub event IDs aren't time-ordered, which the events cursor now accounts for.

## Consequences

- The GitHub event feed holds at most 300 events and ~90 days. For a busy account the first sync reaches back only a few days for commits, reviews and comments (PRs come from search). Coverage marks those days `truncated`; daily syncs keep up from then on.
- `withSystem` relies on the migration role bypassing RLS, like the SECURITY DEFINER helpers (ADR 0005). On a managed Postgres it needs `BYPASSRLS`; tracked with ADR 0005's open item for M7.
- The trigger marks bundles dirty but doesn't rebuild them; staleness of reports follows when reports exist (M3).
- pg-boss still installs its own schema on `start()` (ADR 0003). Enqueueing happens outside `withActor`, so `hub_app` needs no grants on `pgboss`.
