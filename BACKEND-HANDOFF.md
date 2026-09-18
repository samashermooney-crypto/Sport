# Fieldhouse backend handoff

## Assignment and ownership

Finish the backend of a usable sports-management foundation. LeagueApps is only an early reference; do not pursue visual or feature parity. Astra owns the frontend. **Do not edit `src/`, HTML, CSS, frontend dependencies, browser workflows or visual tests.** Your deliverables are server code, database migrations, backend tests, initialization tooling and API documentation.

Workspace: `/Users/sammooney/Sport`. Stack: Express, Node SQLite, Zod; React/TypeScript client. Node 22.13+ required. No Git repository was present at the audit; inspect current state before assuming version-control support. Other work may occur concurrently: never overwrite or revert unfamiliar changes.

Read this document first, then `README.md`, `docs/FOUNDATION.md` and the relevant server files. `docs/REMAINING-WORK.md` is a cross-functional audit, NOT your assignment to implement frontend tasks. `docs/RESUME.md` and `docs/REPLICATION.md` contain historical requirements that are superseded here.

## Existing backend: preserve and extend

Programs/configuration, family/member records, registration questions and versioned waiver evidence, staff/teams/rosters, scheduling/import/results/attendance, invoices/offline receipts/credits/discounts/installments, product orders/inventory/public checkout, member sessions/recovery, website content/privacy, messaging queues/adapters, and registration cancellation/reenrollment/transfers exist.

Do not rebuild them. Current audit baseline: 158 passing tests and successful production build. Tests live in `server/*.test.mjs`. Runtime app typically serves API 3001 and Vite 5173; do not stop another agent's process without coordinating. `scripts/dev.mjs` does not watch backend changes. Never trust a historical process handle without checking it.

Core references:
- `server/app.mjs`: session middleware, admin authentication and route installation.
- `server/db.mjs`: schema, password hashing, transaction and audit helpers; `server/seed.mjs`, `server/index.mjs`: startup.
- `server/member-auth.mjs`, `server/member-recovery.mjs`: member identity and recovery patterns.
- `server/member-profile.mjs`, `server/member-registration.mjs`, `server/forms.mjs`: identity boundaries and retained evidence.
- `server/registration-lifecycle.mjs`, `server/registration-migration.mjs`: atomic cancellation/transfer and active-only uniqueness migration.
- `server/staff-roles.mjs`, `server/program-rules.mjs`, `server/attendance.mjs`: participant roles and actual permission enforcement.
- `scripts/database-copy.mjs`, `docs/BACKUP.md`: tested backup/restore procedure.

## Required batch 1: administrator access lifecycle

Implement organization-scoped console user listing, invitation, invitation resend/revocation, role changes, deactivation/reactivation, password change and password recovery. These do not currently have a complete backend lifecycle. Staff Roles is participant-role configuration, not console access management.

Rules:
- Owner alone manages console invitations, roles and account activation/deactivation for this foundation. Admin/manager/reporter cannot elevate themselves or grant console access.
- Console roles are owner/admin/manager/reporter. Existing coach/parent identities must not acquire console access implicitly.
- Preserve at least one active owner in each organization. Enforce transactionally for demotion and deactivation, including concurrent/stale requests.
- Role changes and deactivation revoke that user's sessions. Deactivation blocks login and outstanding reset/invitation redemption. Preserve audit and operational references; do not hard-delete users.
- Invitations use random, hashed, expiring, one-use tokens. Bind organization, intended normalized email and proposed role server-side. Resend rotates the token; revoke invalidates it. Accepting an invitation cannot choose a different role/organization or take over an existing unrelated identity.
- Password change requires current password; reset requires a valid one-use challenge. Revoke prior sessions on success, invalidate other reset challenges, reject inactive accounts. Use established hashing and password length policy.
- Rate-limit public invitation/recovery endpoints. Public recovery responses must avoid exposing account existence. Never expose hashes, session tokens or invite tokens in ordinary list responses or audit details.
- Existing `users.email` uniqueness and existing member-email overlap need explicit handling. Preserve historical identities; do not silently rewrite ownership or weaken uniqueness to work around conflicts.

## Required batch 2: activate an existing adult member profile

Currently signup rejects an email already present in `people`; recovery requires an existing `member_accounts` row. Implement an owner/admin-controlled invitation flow that links an existing adult person to a verified member login without creating a duplicate person.

Rules:
- Bind challenge to exact organization/person/intended email. At issue AND redemption verify the person remains active, adult and eligible, and that the profile/email/account state has not changed incompatibly.
- Children cannot receive adult credentials. Ambiguous/shared addresses must not merge people or families automatically. Return a clear actionable conflict for the administrator.
- Preserve household memberships, registration history, profile answers/files and privacy boundaries. Account activation must not invent a family-supervisor relationship or grant access to unrelated family members.
- Resend/revoke/expire/reuse protection as above. Multiple attempts must not produce duplicate accounts; enforce atomically.
- Do not remove the existing signup collision check and call that activation. Do not permit self-claiming arbitrary existing records using just an email string.

## Required batch 3: clean initialization

Provide a server-side CLI that creates a real organization and initial owner without demo records. Keep demo setup separate and explicit; production startup must not seed known demo credentials accidentally.

- Read the initial password securely (interactive hidden input or another documented secure method); never log it or put it in examples as a real secret.
- Validate organization name, timezone and owner email/password; current currency implementation is USD, so do not advertise unsupported currency conversion.
- Refuse unsafe reinitialization of an occupied database. Leave existing workspace data untouched.
- Migrations must preserve existing databases and run safely on clean databases. Do not assume application-initialized auth tables already exist when a CLI runs.
- Test clean initialization, repeat refusal, rollback, login with the created owner, and continued operation of an existing demo database.

## Required batch 4: close backend consistency gaps

Audit visible supported permissions against server enforcement. Astra has hidden unsupported staff/captain permission controls in the frontend; stored legacy flags must not grant accidental privileges. Do not build invitations, evaluation, roster submission and scorekeeper subsystems merely because old flags exist.

Extend meaningful integration tests for transfers with required destination answers/acceptances: missing/stale requirements roll back source cancellation and billing changes; valid acceptance creates distinct destination evidence, preserves source history, and idempotent retries do not duplicate it. Existing tests already cover much of cancellation, billing, price changes, backup and auth; inspect them before adding duplicates.

Recheck organization scoping, active-account checks, stale-write handling, session revocation and audit safety across new endpoints. Preserve atomic financial/inventory behavior and active-registration uniqueness.

## API coordination contract

The following are PROPOSED paths for Astra's upcoming UI, not implemented endpoints. Finalize them in `docs/BACKEND-API-CONTRACT.md` before extensive implementation. Keep these names unless a concrete existing conflict warrants a documented change:

| Endpoint | Purpose |
|---|---|
| GET `/api/admin-users` | Owner-only list of safe user fields and pending invitations |
| POST `/api/admin-users/invitations` | Invite console user: email, name, role |
| POST `/api/admin-users/invitations/:id/resend` | Rotate/resend pending invitation |
| DELETE `/api/admin-users/invitations/:id` | Revoke pending invitation |
| PATCH `/api/admin-users/:id` | Update role/active state with expected revision |
| POST `/api/auth/accept-invitation` | Public token + password acceptance |
| POST `/api/auth/change-password` | Authenticated current/new password |
| POST `/api/auth/forgot-password` | Public recovery request |
| POST `/api/auth/reset-password` | Public token + new password |
| GET `/api/people/:id/account-access` | Owner/admin view of active/pending/unlinked member access |
| POST `/api/people/:id/account-invitations` | Invite eligible existing adult |
| POST `/api/people/:id/account-invitations/:inviteId/resend` | Rotate member challenge |
| DELETE `/api/people/:id/account-invitations/:inviteId` | Revoke member challenge |
| POST `/api/member/:org/accept-invitation` | Public token + password activation |

Specify exact request/response shapes, expiry times, revisions, pagination if needed, status codes, and errors. Follow existing `{error: string}` responses; use 401 unauthenticated, 403 forbidden, 409 stale/conflict, 400 invalid input and 503 unavailable delivery. Do not expose private data in errors.

Define token landing paths for the frontend in the contract. Proposed: `/accept-invitation`, `/forgot-password`, `/reset-password` for admins and `/site/:org/account/accept-invitation` for members. Astra implements these screens, not you. Clearly state whether acceptance establishes a session or requires subsequent login, and document cookie/session invalidation behavior.

Provide injectable delivery adapters for tests. Reuse current account-email configuration and clearly labeled development preview behavior; production must never return development links. Configure HTTPS public origin validation. Persist invitation status honestly on delivery failure; do not claim email was delivered merely because a challenge exists. Tests use fake senders; do not actually email anyone.

## Explicit exclusions

No frontend edits. No payments-provider integration, real refunds/autopay, live SMS/email sending, deployment, partner integrations, bookings, tryout/evaluation UI/backend expansion, advanced analytics, alternate site editors or exact-source copying. Local financial records do not move money. Never inspect or mutate the uncle's LeagueApps account. Do not release existing held verification messages. No destructive fixture cleanup or replacement of the active database.

## Verification and handback

Use isolated temporary/in-memory databases. Add domain and HTTP tests for each new lifecycle and its failure/permission boundaries. Run `npm test`; run `npm run build` to catch shared integration breakage, but report frontend errors to Astra rather than editing `src/`. Existing backup tests and clean-database migration tests must continue passing. Test an existing-database migration on a copy before applying anything to working data.

Deliver:
1. Working backend batches above, with passing tests and no live external effects.
2. `docs/BACKEND-API-CONTRACT.md`: implemented APIs with sample non-sensitive JSON, error/state transitions and UI integration notes.
3. Initialization/configuration instructions in a backend-specific document.
4. `docs/BACKEND-HANDOFF-RESULTS.md`: files changed, migrations, exact commands/results, implemented endpoints, remaining limitations and any decisions Astra must reflect in UI.

Do not mark the entire platform complete: Astra still owns new account-management/activation screens and final frontend acceptance. Report backend completion against these batches, not the historical replica backlog.
