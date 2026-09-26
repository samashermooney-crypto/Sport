# 10 — Phases 0–2: Foundation

Each phase lists **Tasks** and **Acceptance criteria**. A phase is complete only when every acceptance criterion is met and the commands in `AGENTS.md` pass.

---

## Phase 0 — Repository reset and tooling

### Tasks
1. Create branch `rebuild/phase-0`. Move `server/` → `legacy/server/`, `src/` → `legacy/web/`, `index.html`, `vite.config.ts`, old `tsconfig*` → `legacy/`. Move superseded docs (list in `AGENTS.md`) to `docs/archive/`. Keep `docs/BACKUP.md` in archive too (replaced in Phase 16). Keep `public/landing` assets. Remove `data/*.sqlite*` from the working tree (it is gitignored; do not delete the owner's local file—leave it on disk, just ensure it is ignored), remove `dist/`, `tsconfig.tsbuildinfo` from git if tracked.
2. Create the layout in `01 §1`. Set up TypeScript project references (`shared`, `server`, `web`) with strict options. Path aliases `@shared/*`, `@server/*`, `@web/*`.
3. Tooling: ESLint (flat config, `typescript-eslint` strict-type-checked, `eslint-plugin-react-hooks`, `jsx-a11y`, `import` ordering, no default exports except where frameworks require), Prettier (existing config), `size-limit`, `knip` (unused files/exports), `lint-staged` + `simple-git-hooks` pre-commit (lint + typecheck staged).
4. `docker-compose.yml`: `postgres:16` (with init script creating `athlentry_app` and `athlentry_admin` roles and dev/test databases), `stripe/stripe-mock`, `axllent/mailpit`. `npm run db:up` / `db:down`.
5. `npm run dev` starts compose (if not running), runs migrations, starts API (`tsx watch server/src/main.ts`), worker (`tsx watch server/src/worker.ts`) and Vite, with prefixed colored logs; stops all on Ctrl-C. Update `.claude/launch.json` to `npm run dev` on port 5173 (web) with API on 3001 proxied under `/api`.
6. Vitest configuration: `server` project uses a global setup that creates a template database by running migrations once, then each test file gets a fresh database `CREATE DATABASE t_<random> TEMPLATE athlentry_template` (fast, isolated), dropped after. `web` project uses jsdom + Testing Library. Playwright configuration with a dedicated e2e database seeded by `db:seed --profile e2e`, servers started by `webServer` config, traces on failure, axe checks helper.
7. GitHub Actions `ci.yml`: Node 24, Postgres 16 service, stripe-mock service; jobs typecheck, lint, test (with coverage upload as artifact), e2e (Chromium + WebKit mobile viewport), build, openapi freshness, `npm audit --omit=dev --audit-level=high`.
8. Create `docs/codex/PROGRESS.md` and `docs/codex/DECISIONS.md` (templates exist; fill in) and `docs/ENVIRONMENT.md`, `.env.example` (no secrets).
9. Rename identifiers per D1. Update `README.md` to describe the rebuild status honestly and point to `docs/codex/`.

### Acceptance criteria
- Fresh clone → `npm ci && npm run db:up && npm run dev` serves a placeholder shell at `http://127.0.0.1:5173` whose only content is the Athlentry sign-in page skeleton (no dead links) and `GET /healthz` returns 200.
- `npm test` runs an example server test against an isolated Postgres database and an example web component test.
- CI passes on the branch.
- `legacy/` contains the old code untouched; nothing outside `legacy/` imports it.

---

## Phase 1 — Platform core: database, identity, orgs, jobs, files, API, app shell

### Tasks

**Database layer**
1. Migration runner, roles, RLS helpers, `withOrg`, Kysely instance, codegen, org counters, idempotency table, audit table, updated_at trigger function, the RLS coverage test (`01 §3`).
2. Money utilities in `shared/src/money.ts` (`20 §1`), date/time utilities with Temporal polyfill (`@js-temporal/polyfill`) for org-timezone math, UUIDv7 ids.

**Identity (all of `02 §B`, `01 §4`)**
3. Sign-up (email, password, name, DOB with 13+ check, ToS/Privacy consent), email verification, sign-in, magic link, sign-out, password reset, change password, change email (verify new address, notify old), MFA enrollment (TOTP QR + manual key + verify), recovery codes (view once, regenerate), MFA challenge at sign-in, step-up re-auth endpoint, session list and revoke, account deletion request (routes to privacy flow).
4. Bearer token issuance for native clients and device-token registration endpoints (web push subscription implemented; apns/fcm accepted and stored but not sent).
5. Rate limiting and Turnstile on public auth endpoints.

**Organizations**
6. Self-serve org creation at `/start`: account (or sign in) → org name, slug (live availability check), kind, timezone, address, primary sport(s) → creates org, owner membership + owner role assignment, default settings, default sport profiles cloned from chosen templates, default season, default credential types (Background check, SafeSport training, Concussion training, Coaching license — all editable/disable-able), default forms (athlete profile with emergency contact & medical sections, guardian contact), default waiver template draft marked "Draft — replace with your own reviewed text" and not publishable until edited, starter plan.
7. Users & roles screen: invite by email with one or more roles and scope, resend, revoke, change roles, suspend/remove membership, last-owner protection, MFA-pending indicator, ownership transfer (owner only, step-up, recipient must accept).
8. Org profile/branding settings with version checks; logo upload through files module.
9. Platform console `/platform`: org list/search, org detail (plan, fees, status, Stripe status), suspend/reactivate org, plan management, feature flags, platform staff management, audited impersonation (reason required, read-only by default, banner in UI, auto-expire 60 minutes), system health (queues, webhooks, worker heartbeat), bootstrap script `scripts/create-platform-admin.ts` with hidden password prompt.

**Infrastructure modules**
10. pg-boss setup, job registry, worker heartbeat, failed-job visibility.
11. Files module (`01 §7`) with S3, local-disk and memory adapters; image processing with EXIF stripping; permission-checked download links.
12. Email module: React Email layout with org branding, `EmailSender` adapters (Resend, Mailpit SMTP via `nodemailer`, Fake), preview mode; send auth emails (verification, magic link, reset, invitations, security alerts) in en/es.
13. Notifications core: `notification_types` catalog in code, `notifications` table, in-app inbox API + SSE stream (`01 §5`), preferences API. (Channels other than in-app/email wired in Phase 10.)
14. Audit module with redaction; audit viewer component.
15. OpenAPI generation, error code enum, pagination helpers, idempotency middleware, version-check helpers.

**Web app shell**
16. Design system per `01 §11a`: capture the legacy visual reference screenshots and `tokens.json` first, extract tokens verbatim from the legacy CSS, port legacy components with identical appearance, then build the remaining components in `01 §11` from those tokens (Storybook-free visual test pages under `/__ui` in development only; light theme only). Then i18n setup (en/es), TanStack Query client, API client with typed endpoints generated from shared schemas, error boundary (port legacy behavior), toast system, layout shells for console/portal/platform/public, org switcher, global search stub wired to `people` once Phase 2 lands (hidden until then), command palette.
17. Auth screens (all flows in task 3), onboarding `/start`, console Home placeholder that shows only real cards available so far (e.g. "Connect payments", "Create your first season") — no fake data.

### Acceptance criteria
- Tenancy: an automated test creates two orgs and proves for every Phase 1 tenant route that org A's actor receives 404 for org B's ids, and a direct SQL query under `withOrg(A)` cannot read B's rows (RLS).
- Identity: tests cover every flow including expiry, reuse, rotation, rate limits, MFA replay protection, step-up expiry, session revocation on password/MFA/role change, last-owner protection under concurrent demotion (two parallel transactions), and under-13 rejection.
- Playwright: new owner signs up → verifies email via Mailpit API → creates org → enrolls MFA → invites an admin → admin accepts invitation in a second browser context, enrolls MFA, signs in → owner changes admin to registrar → admin's session is revoked. All pages pass axe.
- Platform admin can impersonate read-only with banner; every impersonated request is audited with the impersonation id.
- Images uploaded have no EXIF (test with a GPS-tagged fixture).
- Design parity (`01 §11a`): `e2e/visual-reference/` exists; the new shell (header/chrome, navigation, page header) and ported components match the legacy screenshots within tolerance at 1440px and 390px; a unit test proves `tokens.css` values equal `e2e/visual-reference/tokens.json`; no dark theme, CSS framework or styled component library is installed.
- OpenAPI document generated and committed.

---

## Phase 2 — People, households, guardians, medical, forms, imports

### Tasks
1. People CRUD with search (trigram), filters (age, grade, gender, status, program, team, household, has balance, compliance), archive/unarchive, photos (media-consent aware), computed age/grade display using the org's default age config.
2. Households: create/edit, members with roles and flags (`02 §C`), multiple households per person, primary contact rules, household view with all people, registrations, balances.
3. Guardian links: staff links an account to a person as guardian (by existing account email or invitation), guardian invitation flow, athlete (13–17) account invitation by guardian, revocation, self link for adults ("claim your profile" by staff-issued invitation only — port the rules from `legacy/server/member-invitations.mjs`: bound to person+email, re-validated at redemption, never by typing an email).
4. Emergency contacts and medical profile with encryption and audited reads; allergy flags; coach visibility setting.
5. Forms engine: form builder UI (field types in `02 §C`, conditional visibility, required, tier per field, i18n labels en/es), versioning/publishing, rendering component shared by console and portal, response storage with encryption for tiered fields, answer reuse (profile-scoped answers pre-fill future registrations and are only re-asked when the definition version changed or the org marks a field "ask every season").
6. Waiver library: documents with versions, publish/retire, signature capture component (typed name + optional drawn signature), evidence storage (`waiver_signatures`), PDF rendering of a signed waiver (server-side with `pdf-lib` or `@react-pdf/renderer`) for download.
7. Duplicate detection (same DOB + similar name via trigram, or same email/phone) with a merge tool (`person_merges`), blocking conflicts listed.
8. Imports (people, households, guardians, emergency contacts): upload CSV/XLSX (`exceljs`/`papaparse`), column mapping UI with auto-suggest from header names, value transforms (date formats, phone normalization to E.164 with `libphonenumber-js`, gender mapping), validation preview with per-row issues, duplicate matching (create/update/merge/skip per row), transactional commit, rollback of an untouched batch, saved mapping presets. (Other import kinds are added by later phases using the same framework.)
9. Member portal Family section: guardians manage their children's profiles, medical, emergency contacts, photos (with crop), documents; athletes 13–17 read-only view.
10. Global search in console across people and households.

### Acceptance criteria
- A guardian with kids in two orgs (seeded) sees both families in `/me/family`, each profile scoped to its org, and one login.
- Medical read by a coach with `flags_only` returns only flags; with `full` returns details; every read writes an audit entry; registrar without the setting gets 404 for the medical endpoint.
- Import of a 2,000-row fixture with 3 duplicates, 5 invalid rows and mixed date formats previews correct issues, commits in < 30 s, and rolls back cleanly.
- Merge moves registrations, household memberships, credentials, form responses, invoices' person refs and attendance; blocked when both have active registrations in the same program.
- Form versioning: editing a published form creates v2; old responses still render with v1 definition.
- Waiver signature PDF contains the exact signed text, signer, method, timestamp and document hash.
- Playwright: staff creates household with two kids and a guardian invitation; guardian accepts, completes a child's medical info on a 390 px viewport; axe passes.
