# PROGRESS

> Codex: keep this file current. Update it in the same commit that completes an item. Before stopping a session, write the "Next steps" block.

## Next steps
- M0 is on `main` at `d0f59a1`. The spine, ready B/C/D ranges and Phase 1 task 6 are integrated on `rebuild/trunk`. Track B’s jobs, API conventions and audit range is published. Track E’s webhook, Connect, checkout and payer contracts are merged and green locally, pending publication. Track A continues tasks 3–5, 7–8 and 16–17; Track B owns tasks 9 and 13, while Track C owns 11–12. Keep Phase 1 open until every task and acceptance criterion passes.

## Phase status

| Phase | Name | Status | Evidence |
|---|---|---|---|
| 0 | Repository reset and tooling | complete | Local gate green; [GitHub Actions run 36279198481](https://github.com/samashermooney-crypto/Sport/actions/runs/36279198481) passed all 9 jobs on `rebuild/phase-0`. |
| 1 | Platform core | in progress | Branch `rebuild/phase-1` created from green Phase 0. |
| 2 | People, households, forms, imports | not started | |
| 3 | Sport engine, programs, teams, facilities | not started | |
| 4 | Payments and finance | in progress | Test-mode Stripe gateway and ready finance contracts integrated; durable persistence and phase acceptance remain. |
| 5 | Registration | not started | |
| 6 | Evaluations and team formation | not started | |
| 7 | Compliance and safety | not started | |
| 8 | Scheduling and facilities | not started | |
| 9 | Game day, results, tournaments, officials | not started | |
| 10 | Communications | not started | |
| 11 | Volunteers, team finance, fundraising, store | not started | |
| 12 | Academy / class mode | not started | |
| 13 | Federation | not started | |
| 14 | Reporting, website, exports | not started | |
| 15 | Onboarding, imports, demo, AI assist | not started | |
| 16 | Production hardening and launch gate | not started | |

## Track status

| Track | Scope | Model | Status | Branch |
|---|---|---|---|---|
| A | Core and integration | GPT-6 Sol until S1 | working | `track/a-core` |
| B | Sport engine, algorithms, policies; platform infrastructure | GPT-6 Sol | logic queue and Phase 1 tasks 10, 14–15 integrated; tasks 9 and 13 in progress | `track/b-logic` |
| C | Files and provider adapters | GPT-6 Luna | complete adapter queue integrated; files API mounted, acceptance still open | `track/c-adapters` |
| D | Design system | GPT-6 Luna | shared primitives, extended controls, shell and dev showcase integrated; auth restyle still open | `track/d-design` |
| E | Stripe and finance | GPT-6 Sol | test-mode gateway and ready finance contracts integrated; durable money persistence in progress | `track/e-finance` |

## Cross-phase schema spine checkpoint

- [x] Migrations 0100–0113 create the remaining B tables and all tables in `02 §C, D, E, G, H, I, J, L, N, Q` (125 total tables including earlier migrations, plus the code-defined notification type catalog). Forced tenant RLS, composite tenant foreign keys, mutable-aggregate versions, updated-at triggers, enum/capacity checks, partial unique indexes, and foreign-key indexes are present. Catalog tests assert the complete tenant FK graph and index coverage.
- [x] Deferred finance reconciliation checks reject inconsistent invoice totals and payment/refund allocations. PostgreSQL integration tests cover invalid and valid atomic writes.
- [x] Shared Zod entity contracts cover the primary entities across people, programs, registration, scheduling, compliance, officials, attendance, and money. Generated Kysely types introspect 126 tables after the spine (including migration ledger).
- [x] `server/test/factories.ts` provides a typed `row` insert for every tenant table, always inside `withOrg`, plus linked actor, person, household, program, team, registration, invoice, event, and contest presets. Integration tests prove linked rows and cross-tenant isolation.
- [x] Split-space booking expands parent spaces to leaf rows in one transaction; GiST exclusion blocks overlaps, while sibling leaves can be booked independently. A forward-only hierarchy trigger rejects cycles and cross-facility parenting.
- [x] Integrated the spine into `rebuild/trunk` at `f4295a0`; merged trunk passed typecheck, lint, 228 tests (one operator-credential smoke skipped), four browser e2e tests, and build. Trunk publication follows this progress commit; Track E can resume Phase 4 from trunk.
- [x] Integrated Track B's complete logic queue through `5c01024`; merged trunk passed typecheck, lint and 310 tests. Track B's new infrastructure queue is separate and remains open.
- [x] Integrated Track C's adapter queue through `d47dc0f`. Added the files module to the generated registry, local tenant/role authorization, Sharp/Web Push dependencies, migration 0502 for the `files.created_by` FK index, and generated types for 127 tables. Isolated-port browser tests pass with Track C's SMTP offset support; 337 unit/integration tests pass. Task 11 and 12 acceptance remains open pending full API/provider checks.
- [x] Integrated Track B's ready Phase 1 infrastructure range through `727cfe9`: pg-boss worker and heartbeat, redacted audit API/viewer, OpenAPI route coverage, pagination, idempotency and version helpers. Registered the worker and audit route, reconciled files/onboarding API paths, and passed typecheck, lint, 359 tests (one operator-credential smoke skipped), 9 browser tests (3 guarded WebKit design skips), build and knip.
- [x] Integrated Track E's second ready range through `c7dd637`: verified webhook and Connect contracts, checkout holds/pricing, refund and installment policies, payer method orchestration and Payment Element components. The merged trunk passed typecheck, lint, 410 tests (one operator-credential smoke skipped), 9 browser tests (3 guarded WebKit design skips), build, registry/OpenAPI freshness and knip. Phase 4 remains open while durable payment writes and acceptance are built.
- [x] Integrated Track D's ready design range through `a0a20f2`, including frozen tokens, primitives, extended controls, shell and development-only `/__ui` through the feature registry. The merged app passed typecheck, lint, 342 tests, 9 browser e2e tests (3 WebKit design cases intentionally skipped), build and a zero-advisory production audit. Auth restyle and the full Phase 1 design acceptance remain open.

## Phase checklists

### Phase 0 — Repository reset and tooling

- [x] Move old app and superseded docs to `legacy/` and `docs/archive/`; preserve local SQLite data and landing assets; remove tracked build artifacts. Verified `data/fieldhouse.sqlite` remains on disk and is ignored; no tracked `dist/` or build info files.
- [x] Create `01 §1` layout, strict TypeScript project references, and `@shared/*`, `@server/*`, `@web/*` aliases. `npm run typecheck` passed.
- [x] Add ESLint flat config, Prettier, size-limit, knip, lint-staged, and simple-git-hooks. Lint, size, knip and the pre-commit hook passed; main bundle 60.61 KB gzip under 200 KB.
- [x] Add Postgres 16, stripe-mock, and Mailpit Compose services with app/admin roles and dev/test databases; add `db:up` and `db:down`. `npm run db:up` reported all services healthy.
- [x] Make `npm run dev` bring up Compose, migrate, and start API, worker, and Vite with prefixed logs and clean Ctrl-C; update `.claude/launch.json`. Manual startup and Ctrl-C shutdown verified.
- [x] Configure isolated Postgres template-clone server Vitest, jsdom web Vitest, and seeded Playwright e2e with axe helper and failure traces. `server/src/app.test.ts` and `web/src/auth/SignIn.test.tsx` passed (3 tests); `e2e/sign-in.spec.ts` passed on Chromium desktop and WebKit mobile with axe.
- [x] Add CI for Node 24, Postgres, stripe-mock, typecheck, lint, coverage, Chromium and WebKit mobile e2e, build, OpenAPI freshness, and production audit. [Run 36279198481](https://github.com/samashermooney-crypto/Sport/actions/runs/36279198481) passed all 9 jobs.
- [x] Fill `PROGRESS.md`, `DECISIONS.md`, `docs/ENVIRONMENT.md`, and `.env.example` without secrets.
- [x] Rename active identifiers to Athlentry; update README with honest rebuild status. Historical names remain in the untouched legacy archive and old mockups.

### Phase 0 acceptance criteria

- [x] Fresh local clone of commit `1326e0e`: `npm ci && npm run db:up && npm run dev` served the Athlentry sign-in shell at `http://127.0.0.1:5173`; direct `GET /healthz` returned 200. `e2e/sign-in.spec.ts` confirmed no dead links/buttons and passed axe on both browsers. Ctrl-C stopped all processes and containers.
- [x] `npm test` runs a server example against an isolated PostgreSQL database and a web component example. `server/src/app.test.ts` asserted the template-cloned database and migration ledger; `web/src/auth/SignIn.test.tsx` passed.
- [x] CI passes on the branch: [GitHub Actions run 36279198481](https://github.com/samashermooney-crypto/Sport/actions/runs/36279198481), commit `34997b5`.
- [x] Legacy code is preserved untouched in `legacy/`; nothing outside `legacy/` imports it. Byte comparison with pre-rebuild HEAD found 0 differences across 170 old source/config files and 13 archived docs.
- [x] Local phase gate passes: `npm run typecheck`, `npm run lint`, `npm test` (3 passed), `npm run test:e2e` (2 passed), `npm run build`. `npm test -- --coverage`, `npm run size`, `npm run knip`, `npm run openapi`, `npm audit --omit=dev --audit-level=high` and `docker build -t athlentry-phase0 .` also passed.

### Phase 1 — Platform core: database, identity, orgs, jobs, files, API, app shell

#### Tasks

**Database layer**
- [x] 1. Migration runner, roles, RLS helpers, `withOrg`, Kysely instance, codegen, org counters, idempotency table, audit table, updated_at trigger function, the RLS coverage test (`01 §3`). Migrations 0002–0004 applied; generated Kysely types committed; app-role integration tests prove forced RLS, cross-org denial, pooled-connection reset, concurrent counters, updated_at and append-only audit. Local typecheck, lint, tests (7), and knip passed.
- [x] 2. Money utilities in `shared/src/money.ts` (`20 §1`), date/time utilities with Temporal polyfill (`@js-temporal/polyfill`) for org-timezone math, UUIDv7 ids. Unit and property tests verify integer-cent rounding, exact allocation, DST boundaries, leap-day age rules and UUIDv7 generation. Shared tests run without database setup; local typecheck, lint and tests passed.

**Identity (all of `02 §B`, `01 §4`)**
- [ ] 3. Sign-up (email, password, name, DOB with 13+ check, ToS/Privacy consent), email verification, sign-in, magic link, sign-out, password reset, change password, change email (verify new address, notify old), MFA enrollment (TOTP QR + manual key + verify), recovery codes (view once, regenerate), MFA challenge at sign-in, step-up re-auth endpoint, session list and revoke, account deletion request (routes to privacy flow). In progress: migrations 0005–0007 add identity data, MFA challenges, privacy requests and the account-org index. Tested services cover password policy, token rotation/reuse/expiry, sessions, encrypted TOTP with concurrent replay protection, recovery codes, under-13 rejection, exact consent capture, verification, sign-in, reset, password/email change, deletion requests, MFA enrollment and audited pending-role activation. Versioned HTTP routes expose these service flows with strict Zod bodies, JSON error codes, origin/request-header checks and Secure/HttpOnly/SameSite session cookies. Web screens cover all listed flows: sign-up, verification, password/magic-link sign-in, reset/change password, email change confirmation, MFA sign-in/enrollment with locally generated QR and manual key, one-time recovery codes and regeneration, step-up, sessions, and deletion-review request. Local runtime uses Mailpit preview and an ignored encryption key file; production auth startup remains blocked until approved legal text and adapters are configured. Browser e2e covers sign-up through MFA enrollment, recovery regeneration and session revocation on both browser projects; broader expiry, rotation and account-change browser checks remain.
- [ ] 4. Bearer token issuance for native clients and device-token registration endpoints (web push subscription implemented; apns/fcm accepted and stored but not sent). In progress: `POST /api/v1/auth/token` and `/token/mfa` issue hashed, revocable bearer sessions for iOS/Android with MFA challenge; all authenticated auth routes accept the bearer form. `POST/GET/DELETE /api/v1/auth/devices` validate platform against session client, store Web Push subscriptions/APNs/FCM tokens, deduplicate by device fingerprint and scrub subscription data when revoked. Browser code registers a service worker, asks permission, subscribes using a local generated VAPID public key, sends the subscription to the device API and can revoke it. HTTP integration covers native/device contracts; Playwright uses a fake PushManager to exercise registration/revocation without outbound push. A real browser subscription in trusted HTTPS and server-side revocation on session expiry remain before this item is checked.
- [ ] 5. Rate limiting and Turnstile on public auth endpoints. In progress: migration 0009 adds the shared Postgres rate-limit table; `rate-limiter-flexible` enforces 8 sign-ins per 15 minutes per IP+email, 5/hour per email and 30/hour per IP on magic-link and password-recovery requests. Additional local protection covers sign-up and MFA challenge by IP. Keys are SHA-256 digests, not raw identifiers. HTTP integration confirms 429 with `Retry-After`, and Postgres tests check limits and key privacy. Cloudflare Turnstile Siteverify adapter validates success, hostname and `sign-up` action with a timeout; fake fetch tests cover rejection and unavailable service. The browser now requests CAPTCHA mode and renders an explicit Turnstile widget with action `sign-up` when configured; local/test mode stays on AlwaysPass. Production credentials and adapter startup remain pending. Expired limiter cleanup is deferred to the Phase 1 job registry.

**Organizations**
- [x] 6. Self-serve org creation at `/start`: account (or sign in) → org name, slug (live availability check), kind, timezone, address, primary sport(s) → creates org, owner membership + owner role assignment, default settings, default sport profiles cloned from chosen templates, default season, default credential types (Background check, SafeSport training, Concussion training, Coaching license — all editable/disable-able), default forms (athlete profile with emergency contact & medical sections, guardian contact), default waiver template draft marked "Draft — replace with your own reviewed text" and not publishable until edited, starter plan. Migration 0010 and transactional bootstrap have Postgres isolation tests. All 46 built-in sports seed idempotently. The authenticated `/start` form checks slug availability. Owners can edit and disable each credential through MFA and step-up guarded, version-checked routes; HTTP tests cover cross-tenant 404, conflict, audit and expired step-up. Playwright covers signup → verification → MFA → org creation → safety requirement edit on desktop and mobile with axe. Local gate: typecheck, lint, 343 tests (one operator-credential smoke skipped), 9 browser e2e tests (3 guarded WebKit design skips), build and knip pass.
- [ ] 7. Users & roles screen: invite by email with one or more roles and scope, resend, revoke, change roles, suspend/remove membership, last-owner protection, MFA-pending indicator, ownership transfer (owner only, step-up, recipient must accept).
- [ ] 8. Org profile/branding settings with version checks; logo upload through files module.
- [ ] 9. Platform console `/platform`: org list/search, org detail (plan, fees, status, Stripe status), suspend/reactivate org, plan management, feature flags, platform staff management, audited impersonation (reason required, read-only by default, banner in UI, auto-expire 60 minutes), system health (queues, webhooks, worker heartbeat), bootstrap script `scripts/create-platform-admin.ts` with hidden password prompt.

**Infrastructure modules**
- [x] 10. pg-boss setup, job registry, worker heartbeat, failed-job visibility. Migration 0600, registered worker with graceful stop, heartbeat and redacted failed-job health reader pass the merged local gate.
- [ ] 11. **Track C:** Files module (`01 §7`) with S3, local-disk and memory adapters; image processing with EXIF stripping; permission-checked download links.
- [ ] 12. **Track C:** Email module: React Email layout with org branding, `EmailSender` adapters (Resend, Mailpit SMTP via `nodemailer`, Fake), preview mode; send auth emails (verification, magic link, reset, invitations, security alerts) in en/es.
- [ ] 13. Notifications core: `notification_types` catalog in code, `notifications` table, in-app inbox API + SSE stream (`01 §5`), preferences API. (Channels other than in-app/email wired in Phase 10.)
- [x] 14. Audit module with redaction; audit viewer component. Append-only service, Restricted-field redaction/read audit, role-scoped cursor API and functional console viewer pass merged tests; route is mounted through the web registry.
- [x] 15. OpenAPI generation, error code enum, pagination helpers, idempotency middleware, version-check helpers. The generated OpenAPI document covers current auth, org, files and audit operations; route coverage check, helper tests and merged full gate pass.

**Web app shell**
- [ ] 16. **Track D:** Design system per `01 §11a`: capture the legacy visual reference screenshots and `tokens.json` first, extract tokens verbatim from the legacy CSS, port legacy components with identical appearance, then build the remaining components in `01 §11` from those tokens (Storybook-free visual test pages under `/__ui` in development only; light theme only). Then i18n setup (en/es), TanStack Query client, API client with typed endpoints generated from shared schemas, error boundary (port legacy behavior), toast system, layout shells for console/portal/platform/public, org switcher, global search stub wired to `people` once Phase 2 lands (hidden until then), command palette. In progress: isolated legacy worktree at `9ef77bb` generated 12 desktop and 12 mobile screenshots in `e2e/visual-reference/`, including sign-in, dashboard, lists/editors, team, invoice, schedule, public site, member portal and modal. The extracted `tokens.json` freezes all legacy custom properties plus recurring colors, type sizes, spacing, radii, heights and shadows; `web/src/ui/tokens.css` contains those exact values. A Vitest assertion checks CSS against the frozen snapshot after formatting normalization (41 tests pass). Component ports and shell parity remain open.
- [ ] 17. Auth screens (all flows in task 3), onboarding `/start`, console Home placeholder that shows only real cards available so far (e.g. "Connect payments", "Create your first season") — no fake data. In progress: functional identity, account-security and `/start` routes exist; console Home and the remaining identity browser checks remain.

#### Acceptance criteria
- [ ] Tenancy: an automated test creates two orgs and proves for every Phase 1 tenant route that org A's actor receives 404 for org B's ids, and a direct SQL query under `withOrg(A)` cannot read B's rows (RLS).
- [ ] Identity: tests cover every flow including expiry, reuse, rotation, rate limits, MFA replay protection, step-up expiry, session revocation on password/MFA/role change, last-owner protection under concurrent demotion (two parallel transactions), and under-13 rejection.
- [ ] Playwright: new owner signs up → verifies email via Mailpit API → creates org → enrolls MFA → invites an admin → admin accepts invitation in a second browser context, enrolls MFA, signs in → owner changes admin to registrar → admin's session is revoked. All pages pass axe.
- [ ] Platform admin can impersonate read-only with banner; every impersonated request is audited with the impersonation id.
- [ ] Images uploaded have no EXIF (test with a GPS-tagged fixture).
- [ ] Design parity (`01 §11a`): `e2e/visual-reference/` exists; the new shell (header/chrome, navigation, page header) and ported components match the legacy screenshots within tolerance at 1440px and 390px; a unit test proves `tokens.css` values equal `e2e/visual-reference/tokens.json`; no dark theme, CSS framework or styled component library is installed.
- [x] OpenAPI document generated and committed with route coverage for current auth, org, files and audit operations; `npm run openapi` passes on merged trunk.
