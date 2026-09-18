# Backend API contract — account access lifecycle

This document finalizes the administrator-console and member-account access APIs
proposed in `BACKEND-HANDOFF.md`. It is the contract Astra's UI should build
against. All endpoints are implemented in `server/` and covered by
`server/admin-users.test.mjs`, `server/member-invitations.test.mjs` and
`server/initialize.test.mjs`.

Conventions shared by every endpoint here:

- Errors use the existing shape `{ "error": "Human readable message" }`.
- `401` unauthenticated, `403` forbidden, `404` not found / wrong organization,
  `400` invalid input (Zod details surface as the error string), `409`
  stale/conflict, `429` rate limited, `503` delivery unavailable.
- Bodies are JSON. Mutating endpoints require the `X-Fieldhouse-Request: 1`
  header (existing request-source check) and, when cross-origin, an allowed
  `Origin`.
- No response ever contains a password hash, token hash, raw invitation token,
  or session token. Tokens appear only inside emailed links or clearly labeled
  development previews.
- Public endpoints are rate limited per IP + action: 6 attempts per 15 minutes
  (`429` after). Console login keeps its existing 8-per-15-minute limit.

## Console sessions

The console session cookie is `fieldhouse_session`: `HttpOnly`,
`SameSite=Strict`, `Path=/`, 24-hour `Max-Age`, `Secure` when
`COOKIE_SECURE=true`. Server-side rows in `sessions` store only a SHA-256 hash.

A session is invalidated when:

- the user signs out (`POST /api/auth/logout`),
- an owner changes the user's role or deactivates them,
- the user's password is changed or reset,
- the user is deactivated (session lookup also requires `users.active=1`, so a
  deactivated user's cookie immediately stops resolving), or
- it expires.

`GET /api/session` returns `{ user: {id,name,email,role,org_id}, organization }`
for a valid console session. Member sessions are a separate cookie and never
satisfy console routes.

## Console user access (owner only)

Console roles are `owner`, `admin`, `manager`, `reporter`. Stored `coach` and
`parent` user roles still exist for history but receive `403` from every console
route. Reporter sessions may only issue `GET`/`HEAD`.

All endpoints in this section require a console session whose `role` is
`owner`. Any other console role receives `403`.

### `GET /api/admin-users`

Response `200`:

```json
{
  "users": [
    {
      "id": "uuid",
      "name": "Jordan Owner",
      "email": "owner@example.com",
      "role": "owner",
      "active": true,
      "revision": 3,
      "deactivated_at": null
    }
  ],
  "invitations": [
    {
      "id": "uuid",
      "email": "manager@example.com",
      "name": "Casey Manager",
      "role": "manager",
      "status": "Pending",
      "expires_at": "2026-02-18T19:00:00.000Z",
      "sent_at": null,
      "delivery_error": "",
      "created_at": "2026-02-11T19:00:00.000Z"
    }
  ]
}
```

`revision` is the optimistic-concurrency token for `PATCH`. Invitation
`status` is `Pending`, `Accepted` or `Revoked`. `sent_at` is `null` until a
provider actually accepts the message; `delivery_error` records a failed send.

### `POST /api/admin-users/invitations`

Request: `{ "email": "manager@example.com", "name": "Casey Manager", "role": "manager" }`

- `email` is normalized (trim + lowercase); `role` must be a console role.
- `409` if the email already has console access, belongs to a member account in
  this organization, or already has a pending invitation (the error body is
  `{error, invitation_id}` so the UI can offer resend/revoke).
- `503` when live delivery is unconfigured in production — no invitation row is
  persisted in that case.

Response `201` (development preview, when auth email delivery is disabled and
`NODE_ENV` is not production):

```json
{
  "id": "uuid",
  "email": "manager@example.com",
  "name": "Casey Manager",
  "role": "manager",
  "status": "Pending",
  "expires_at": "...",
  "sent_at": null,
  "delivery_error": "",
  "created_at": "...",
  "delivery": "preview",
  "development_link": "/accept-invitation?token=<64 hex>"
}
```

Response `201` (live delivery succeeded): the same invitation fields plus
`"delivery": "sent"` and a non-null `sent_at`. No `development_link` is ever
returned outside preview mode.

Response `503` (provider attempted and failed): the invitation **is** persisted
with `delivery_error` set and `sent_at: null`; the error body tells the
administrator to resend from the user list.

### `POST /api/admin-users/invitations/:id/resend`

Rotates the token and expiry (a fresh 7 days) and redelivers. Same
preview/sent/503 semantics as creation; response status is `200`. `404` unknown
id, `409` if the invitation is no longer pending or the email has since been
claimed.

### `DELETE /api/admin-users/invitations/:id`

Marks a pending invitation `Revoked`; the token can no longer be redeemed.
Response `200` `{ "ok": true }`. `404`/`409` as above.

### `PATCH /api/admin-users/:id`

Request: `{ "role": "admin", "active": true, "expected_revision": 3 }` — at
least one of `role`/`active` is required; `expected_revision` is required and
must match the listed `revision` or the request fails `409`
("This user changed. Reload before saving.").

- Role changes and deactivation delete all of the target's console sessions.
- Deactivation blocks login and prevents redemption of outstanding invitation
  and reset tokens; reactivation clears `deactivated_at`.
- The last active owner cannot be demoted or deactivated (`409`,
  "Keep at least one active owner. Promote another owner first."). The check
  runs inside the same transaction as the update, so stale/concurrent requests
  cannot strand the organization without an owner.
- Users are never deleted; `deactivated_at` and audit history are preserved.

Response `200`: the updated safe user object (same shape as the list entry).

## Public console auth

Installed before the session gate; rate limited as described above.

### `POST /api/auth/accept-invitation`

Request: `{ "token": "<64 hex>", "password": "...", "name": "optional override" }`

- Password policy: 12–128 characters.
- `400` invalid/expired/revoked/already-used token. `409` if the invited email
  has since been claimed.
- The organization, email and role come **only** from the invitation; the
  request cannot choose them.
- Response `200`: the new console user JSON plus a `fieldhouse_session` cookie —
  acceptance **establishes a session**; no separate login is needed.
- Landing path for emailed/development links: `/accept-invitation?token=...`.

### `POST /api/auth/forgot-password`

Request: `{ "email": "owner@example.com" }`

- Always `202` with a fixed message: "If an active console account matches that
  email, a password reset link will be sent. It expires in 30 minutes." The
  response does not disclose whether the account exists. Deactivated and
  unknown accounts silently produce no challenge.
- In preview mode the body also carries `development_link`:
  `/reset-password?token=<64 hex>` — never returned in production.
- A successful request replaces any outstanding reset challenge for that user.
- `503` only when production delivery is entirely unconfigured (there is no
  account to leak in that case).
- Landing path: `/forgot-password` for the request form; `/reset-password?token=...` for redemption.

### `POST /api/auth/reset-password`

Request: `{ "token": "<64 hex>", "password": "..." }`

- `400` invalid/expired token or token belonging to a deactivated account.
- Success `200` `{ "ok": true }`: updates the password, deletes all of the
  user's sessions and reset challenges, clears the cookie, and bumps
  `revision`. The client should then sign in normally.
- Reset tokens live 30 minutes and are one-use.

### `POST /api/auth/change-password`

Authenticated. Request: `{ "current_password": "...", "new_password": "..." }`

- `400` wrong current password or weak new password; `403` deactivated account.
- Success `200` `{ "ok": true }`: deletes all prior sessions (including the
  current one), then issues a fresh `fieldhouse_session` cookie so the user is
  not kicked out of the current browser.

## Member account access (owner/admin)

Requires a console session with role `owner` or `admin`; manager and reporter
receive `403`. Everything is scoped to the caller's organization — a `person_id`
from another organization returns `404`.

### `GET /api/people/:id/account-access`

Response `200`:

```json
{
  "person_id": "uuid",
  "state": "none",
  "account": null,
  "invitations": [],
  "eligible": true,
  "reason": ""
}
```

- `state`: `none` | `pending` | `active`.
- `account` (when `active`): `{id, email, verified_at, created_at}`.
- `invitations`: safe invitation objects (`id,email,status,expires_at,sent_at,delivery_error,created_at`).
- `eligible` is `false` with a human-readable `reason` when the person is
  archived, is a child (no provable 18+ birthdate on a non-parent/staff record),
  or already has an account.

### `POST /api/people/:id/account-invitations`

Request: `{}` or `{ "email": "supplied@example.com" }`.

- The invitation binds the exact `org_id`, `person_id` and intended email.
- If the member record has an email, a supplied email must match it (`409` —
  "Update the member record first"). If the record has no email, the supplied
  email is required (`400`) and becomes the record's contact email at
  activation.
- `409` when the email is shared by another person record in the same organization (including case/whitespace variants). Update the adult profile to a unique address first. This check also runs at resend and activation.
- `409` when the member is ineligible, already has a pending invitation
  (`{error, invitation_id}`), or the email conflicts with an existing member or
  console account in this organization.
- Delivery semantics are identical to console invitations: `201` with
  `delivery: "preview"` + `development_link` in development, `delivery: "sent"`
  after provider acceptance, `503` honest failure (row persisted with
  `delivery_error`), `503` with no row when production delivery is
  unconfigured.

### `POST /api/people/:id/account-invitations/:inviteId/resend`

`200`; rotates token + expiry and re-verifies the member is still an eligible
adult whose record email has not changed (`409` when it has — revoke and
re-issue instead).

### `DELETE /api/people/:id/account-invitations/:inviteId`

`200` `{ "ok": true }`; marks the challenge `Revoked`.

### `POST /api/member/:org/accept-invitation`

Public; rate limited; `:org` is the organization id embedded in the link.
Request: `{ "token": "<64 hex>", "password": "..." }`.

- `400` invalid/expired/revoked token (including a token issued for a different
  org). `409` when the member record changed incompatibly since issue — record
  email changed, member archived or no longer adult, or an account now exists.
- On success the `member_accounts` row is created for the bound `person_id` and
  email only; remaining pending invitations for that person are revoked.
- Activation never invents household relationships: the account sees the same
  family the person's existing `household_members` rows already grant, nothing
  more.
- Response `200` `{ "ok": true }` plus the member session cookie — activation
  **establishes a member session** for `/site/:org`. It grants no console
  access.
- Landing path: `/site/:org/account/accept-invitation?token=...`.

## Delivery behavior

Both lifecycles share `server/auth-delivery.mjs`:

- **Preview mode** (development, `AUTH_EMAIL_DELIVERY_ENABLED` unset): the API
  returns the invitation/reset path in `development_link`. The field name is a
  contract — the UI may render it as a labeled "Development preview" chip, but
  production responses never include it.
- **Live mode** (`AUTH_EMAIL_DELIVERY_ENABLED=true` with `RESEND_API_KEY`,
  `MAIL_FROM`, `PUBLIC_URL`): the link is emailed via Resend with an
  idempotency key derived from the token hash. `PUBLIC_URL` must be HTTPS in
  production or delivery fails `503`.
- `sent_at`/`delivery_error` are persisted truthfully; a `201` with
  `delivery:"sent"` means the provider accepted the message, not that it
  arrived.

## State transitions

Console invitation: `Pending` → `Accepted` | `Revoked`. `Pending` rows also die
by `expires_at` (7 days). Resend keeps the row but rotates `token_hash` and
`expires_at`.

Console user: `active` flips via `PATCH`; `revision` increments on every role,
active or password change. Last-active-owner transitions are rejected.

Member invitation: identical lifecycle to console invitations, additionally
bound to `person_id` + `person_email` snapshot which is re-verified at resend
and redemption.

## Frontend notes for Astra

- Console screens to build: user list (users + pending invitations), invite
  dialog, resend/revoke actions, role/deactivate controls with
  `expected_revision`, change-password form, `/forgot-password`,
  `/reset-password`, `/accept-invitation` landing pages.
- Member-side: "Account access" panel on an adult member record (state +
  invite/resend/revoke), and the `/site/:org/account/accept-invitation` screen.
- After `accept-invitation` (either side) the browser already holds a session —
  route to the signed-in landing page, not a login form.
- Treat `409` responses as "reload and retry" — surface `error` verbatim and
  refetch the list/account-access view.
- `delivery_error` / `sent_at` on an invitation tell the truth about sending;
  do not show "email sent" for rows with `sent_at: null`.
