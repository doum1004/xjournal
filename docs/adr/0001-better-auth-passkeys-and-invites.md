# ADR 0001: Better Auth for passkeys, invites and device approval

**Status:** Accepted, 2026-11-08 (M0 spike 1)
**Versions:** `better-auth` 1.7.18, `@better-auth/passkey` 1.7.18 (uses `@simplewebauthn/server` 13)

## Context

Spec §11.5 requires password-free sign-in for the personal domain: a single-use invite link plus a confirmation code sent through another channel, passkey registration only, owner approval of new devices, and recovery invites that revoke old passkeys. `plan.md` §3 names SimpleWebAuthn plus custom code as the fallback if Better Auth didn't fit.

## Decision

Use Better Auth with its passkey plugin. The invite flow is hub code around two documented hooks:

1. `POST /api/v1/auth/invites/redeem {token, code}` (`apps/server/src/app.ts`). The link token is looked up by `sha256`; the code is compared as `HMAC(server secret, code)` in constant time. Five wrong codes invalidate the invite (422 with attempts remaining, then 410). A used link fails with 409 `already_used` (leak detection). On success the endpoint returns Better Auth's WebAuthn registration options directly, passing a signed 10-minute **ticket** (invite ID + the user ID to create) as the passkey `context`.
2. Passkey plugin `registration.requireSession: false` + `resolveUser` (checks the ticket) + `afterVerification` (`packages/db/src/repos/auth.ts` `consumeInvite`): locks the invite row, creates the user and membership (join) or revokes the member's passkeys (recovery), and marks the invite used. Throwing here aborts the registration.
3. An `after` hook on `/passkey/verify-registration` links the stored passkey to its invite and sets `status` from `projects.require_device_approval` (default: `pending`).
4. Device approval: `authentication.afterVerification` runs **before** Better Auth creates a session. A passkey that isn't `approved` gets 403 `device_pending` and no session. Managers approve through RLS (`passkeys_update` policy, ADR 0005).

Registration never creates a session (`createSession` isn't requested), so a leaked link plus code still ends at a pending device.

Better Auth's database connection runs as the `hub_auth` role (ADR 0005), which can reach the sign-in tables only.

## Evidence

`apps/server/test/auth.test.ts`, through the real HTTP app with a software WebAuthn authenticator (`packages/auth/test/soft-authenticator.ts`, ES256, `none` attestation), on PGlite and on Postgres 17 (where Better Auth runs as `hub_auth`):

- wrong code → 422 "4 attempts remaining"; five wrong codes → 410
- link + code → passkey stored, user and `contributor` membership created, invite used, passkey `pending` and linked to the invite
- registration alone yields no session; a reused link → 409
- pending device sign-in → 403 `device_pending`; after a manager approves → session for the new user
- recovery invite → new passkey for the existing user, old passkey `revoked`, no duplicate user

## Consequences: deviations from the original `schema.md` §3 (now folded in)

Better Auth owns the shape of `users`, `sessions` and `passkeys`. Mapped through its `modelName`/`fields` options:

| Table | Deviation | Why / mitigation |
|---|---|---|
| `users` | Adds `email_verified`, `image`, `updated_at`. `email` stays nullable. | Required by Better Auth's schema. Users created by the invite flow have a null email; `get-session` works with that. Better Auth's API calls `display_name` `user.name`. |
| `sessions` | `token` holds the raw session token, not `token_hash`; adds `updated_at`; `ip_address` instead of `ip_hash`. | Better Auth 1.7 has no option to hash session tokens. Session cookies are HMAC-signed with the server secret and the bearer plugin is off, so a database read alone can't produce a usable cookie. See open items for the IP. |
| `passkeys` | Adds `device_type`, `backed_up`, `transports`, `aaguid`. `device_label` is Better Auth's `name`. | WebAuthn metadata the plugin stores. |
| New | `accounts` (always empty), `verifications` (WebAuthn challenges), `jwks`, `oauth_*` (ADR 0002). | `accounts` is required by Better Auth's startup schema check even with passkey-only sign-in. `hub_app` has no grants on any of them. |

Other consequences:
- `consumeInvite` commits in its own transaction just before Better Auth inserts the passkey. If that insert then fails, the invite is spent and the inviter reissues one. Acceptable for a rare failure; the alternative is forking the plugin.
- Better Auth's built-in rate limiter covers `/api/auth/*` only. The redeem endpoint relies on the five-attempt limit per invite until the API rate limiter exists (M7).
- SimpleWebAuthn-only fallback: not needed.

## Open items

- `sessions.passkey_id` is not populated (Better Auth doesn't pass the passkey to `createSession`). Populate it from the sign-in hook in M7, or drop the column.
- Store `ip_hash` instead of the raw IP (Better Auth `advanced.ipAddress` options, or a session `create.before` hook), M7.
- The sign-in and consent pages (`/sign-in`, `/consent`) and add-a-device-by-QR are UI work for M7.
