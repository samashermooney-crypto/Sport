# Backend handoff results

Completion report for `BACKEND-HANDOFF.md`. Backend scope only — Astra owns the
new account-management and activation screens; the platform as a whole is not
being marked complete.

## Result summary

- `npm test` → **183 passing** (baseline was 158; +25 new tests), 0 failures.
- `npm run build` → successful (Vite production build; no frontend changes made).
- All verification ran on isolated `:memory:` or temporary databases. No live
  email/SMS was sent; delivery was exercised only through injected fake senders.
- No Git repository exists in the workspace, so "files changed" is listed
  explicitly below.

## Files added

| File | Contents |
|---|---|
| `server/admin-users.mjs` | Console access lifecycle: list, invite/resend/revoke, PATCH role+active with expected_revision, accept-invitation, forgot/reset/change password, owner gate, rate limiter, route installers |
| `server/member-invitations.mjs` | Existing-adult account access: account-access view, invite/resend/revoke, public activation bound to `person_id` + email snapshot |
| `server/auth-delivery.mjs` | Shared delivery helper: preview vs live mode, HTTPS `PUBLIC_URL` validation, Resend call with token-hash idempotency key, injectable `send` for tests |
| `server/initialize.mjs` | `npm run init` CLI: validated org + first owner, hidden password prompt or `FIELDHOUSE_OWNER_PASSWORD`, occupied-database refusal |
| `server/admin-users.test.mjs` | 10 tests: domain + HTTP lifecycle, permissions, last-owner, sessions, recovery, production delivery honesty, rate limits |
| `server/member-invitations.test.mjs` | 6 tests: person/email binding, eligibility drift, resend/revoke/expiry, household preservation, HTTP lifecycle, delivery failure |
| `server/initialize.test.mjs` | 6 tests: clean init + login, repeat refusal, rollback, demo DB refusal, legacy `users` migration, seed gating |
| `server/registration-transfer-forms.test.mjs` | 3 tests: transfers with required destination answers/waivers — rollback on missing/stale, distinct evidence, idempotent retry |
| `docs/BACKEND-API-CONTRACT.md` | Finalized endpoint contract for Astra |
| `docs/BACKEND-INITIALIZATION.md` | Initialization + environment configuration |

## Files modified

| File | Change |
|---|---|
| `server/db.mjs` | `users` gained `active`, `revision`, `deactivated_at`; new tables `admin_invitations` (+one-pending index), `admin_reset_tokens`, `member_account_invitations` (+one-pending index); `migrateConsoleAccess` adds the columns on existing databases |
| `server/app.mjs` | Session lookup requires `users.active=1`; login rejects deactivated accounts (`403`); installed console-auth/member-auth routes before the gate and admin/member access routes after the console-role gate; wired `POST /api/auth/change-password` |
| `server/member-auth.mjs` | Installed public `POST /api/member/:org/accept-invitation` (rate-limited, issues member session) |
| `server/seed.mjs` | `shouldSeedDemo(env)` gate |
| `server/index.mjs` | Seeds only when `shouldSeedDemo()` allows (never in production unless `SEED_DEMO=true`) |
| `package.json` | Added `npm run init` → `node server/initialize.mjs` |
| `README.md` | Initialization + docs pointers |
| `server/*.mjs` (various) | Existing positional `INSERT INTO users` statements switched to named columns so the extended schema stays explicit |

## Implemented endpoints

Exactly the proposed contract — no renames were needed:

- `GET /api/admin-users` (owner) — safe users + invitations.
- `POST /api/admin-users/invitations` (owner) — `201`; `409` on
  console/member-email/pending conflicts.
- `POST /api/admin-users/invitations/:id/resend` (owner) — `200`, token rotated.
- `DELETE /api/admin-users/invitations/:id` (owner) — revoke.
- `PATCH /api/admin-users/:id` (owner) — `{role?, active?, expected_revision}`;
  `409` stale revision or last-active-owner; revokes target sessions.
- `POST /api/auth/accept-invitation` — `200` + console session.
- `POST /api/auth/change-password` — current-password check; revokes prior
  sessions and reissues one.
- `POST /api/auth/forgot-password` — always `202`, no account disclosure.
- `POST /api/auth/reset-password` — one-use 30-minute challenge; revokes
  sessions.
- `GET /api/people/:id/account-access` (owner/admin) — `none|pending|active` +
  eligibility reason.
- `POST /api/people/:id/account-invitations` (owner/admin) — bound to the exact
  `person_id` and record email.
- `POST /api/people/:id/account-invitations/:inviteId/resend` / `DELETE` —
  rotate/revoke with eligibility re-verification.
- `POST /api/member/:org/accept-invitation` — `200` + member session.

Landing paths for Astra: `/accept-invitation`, `/forgot-password`,
`/reset-password`, `/site/:org/account/accept-invitation`.

## Notable decisions

- **Last-owner protection is transactional**: the demote/deactivate check runs
  inside the same `BEGIN IMMEDIATE` transaction as the update, so stale or
  concurrent requests can't strand an org.
- **Delivery honesty**: production requests fail `503` *before* a challenge is
  persisted when delivery is unconfigured (no phantom pending rows). When a
  provider attempt fails, the invitation row persists with `delivery_error` and
  `sent_at: null` so the UI never claims it was sent.
- **Member activation binds a snapshot**: `person_email` is captured at issue
  and re-verified at resend and redemption; drift, archiving or a child edit
  invalidates the challenge with `409`.
- **No arbitrary claiming**: activation never merges people, never invents
  `household_members` supervision, and an admin-supplied email only fills an
  empty record email.
- **Legacy flags can't grant privileges**: `coach`/`parent` console roles get
  `403` from all console routes; staff-role flags are only read in restrictive
  gates (`can_register` for staff self-registration, `can_check_in` for
  attendance roster scope). Unevaluated flags like `can_submit_roster` have no
  consuming endpoint — deliberately, per the handoff.
- **Token storage**: invitation/reset tokens are random 32-byte hex values
  stored only as SHA-256 hashes; console invitations live 7 days, console reset
  challenges 30 minutes, member invitations 7 days. Resend rotates; acceptance
  is one-use.

## Verification commands and results

```text
npm test                         → 183 pass / 0 fail (~3.9s)
npm run build                    → vite build ok
node --test server/admin-users.test.mjs               → 10 pass
node --test server/member-invitations.test.mjs        → 6 pass
node --test server/initialize.test.mjs                → 6 pass
node --test server/registration-transfer-forms.test.mjs → 3 pass
```

Migration was exercised on a synthetic legacy database (pre-column `users`
table) inside `initialize.test.mjs` and on in-memory copies — the working
`data/fieldhouse.sqlite` was not modified.

## Remaining limitations / Astra to-dos

- Live email delivery via Resend is implemented but unverified against a real
  account; development uses labeled `development_link` previews.
- The new screens listed in the contract (console user management,
  forgot/reset/accept pages, member account-access panel, member activation
  page) are unbuilt — frontend work.
- `npm run init` was verified on clean/occupied/legacy databases locally; a
  production deploy still needs HTTPS, `PUBLIC_URL`, and secret configuration.
- No payments-provider, deployment, or platform-complete claims.
