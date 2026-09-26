# 01 — Architecture

## 1. Repository layout

Single npm package with npm workspaces is unnecessary; use one `package.json` and path aliases. Target layout:

```
/AGENTS.md
/package.json                 # scripts, deps, engines { node: ">=24" }
/tsconfig.base.json           # strict, noUncheckedIndexedAccess, exactOptionalPropertyTypes
/docker-compose.yml           # postgres:16, stripe/stripe-mock, axllent/mailpit
/Dockerfile                   # multi-stage; runs web or worker by CMD
/render.yaml                  # reference deployment (web, worker, cron-less; pg-boss schedules jobs)
/.github/workflows/ci.yml     # typecheck, lint, unit+integration (postgres service), e2e, build
/db/
  migrations/0001_platform.sql ...   # forward-only SQL migrations, numbered, one concern each
  seeds/                              # deterministic demo generators (TypeScript)
/shared/src/                  # imported by server and web via "@shared/*"
  schemas/                    # Zod request/response schemas, one file per module
  sport/                      # sport-profile schema, built-in templates, result math, age groups
  permissions.ts              # role → permission map, scope helpers
  money.ts dates.ts ids.ts    # pure utilities used on both sides
/server/src/
  main.ts                     # HTTP server entry
  worker.ts                   # pg-boss worker entry
  app.ts                      # express app factory (DI of adapters for tests)
  config.ts                   # env parsing with Zod; fail fast on invalid config
  db/ kysely.ts withOrg.ts types.ts(generated) migrate.ts
  lib/ errors.ts http.ts pagination.ts idempotency.ts audit.ts crypto.ts rate-limit.ts logger.ts sse.ts
  integrations/ stripe/ email/ sms/ push/ storage/ background-checks/ turnstile/ geocode/
  modules/<module>/ routes.ts service.ts repo.ts policy.ts jobs.ts *.test.ts
  jobs/registry.ts            # queue names, schedules, handlers
/web/src/
  main.tsx router.tsx
  ui/                         # design system components + tokens.css
  lib/ api.ts query.ts i18n.ts format.ts
  console/<feature>/          # admin console screens
  portal/<feature>/           # family/athlete/coach/official/volunteer screens
  site/                       # public org website renderer
  marketing/                  # Athlentry marketing site (ported legacy landing page), pricing, legal pages
  platform/                   # platform-staff console
  auth/                       # sign-in, sign-up, MFA, invitations, recovery
  i18n/en/*.json i18n/es/*.json
/e2e/                         # Playwright specs + fixtures
/scripts/                     # one-off operator scripts (vapid keys, create platform admin, backups)
/docs/api/openapi.json        # generated
/docs/codex/                  # this handoff
/legacy/                      # old server/ and src/ (Phase 0 → deleted in Phase 16)
```

Modules (server `modules/` and matching web features): `auth`, `accounts`, `orgs`, `platform`, `people`, `households`, `medical`, `forms`, `imports`, `sports`, `seasons`, `programs`, `offerings`, `registration`, `checkout`, `waivers`, `evaluations`, `teams`, `rosters`, `compliance`, `safety` (injuries/incidents), `facilities`, `scheduling`, `contests` (results/stats), `standings`, `tournaments`, `officials`, `discipline`, `attendance`, `communications`, `notifications`, `chat`, `volunteers`, `finance` (invoices, payments, plans, refunds, disputes, payouts, credits, discounts, aid), `team-finance`, `fundraising`, `sponsors`, `store`, `classes`, `federation`, `reports`, `action-center`, `website`, `exports`, `audit`.

Module boundaries: a module's `repo.ts` is the only place that touches its tables. Other modules call its `service.ts`. Cross-module transactions pass the transaction handle (`trx`) explicitly.

## 2. Runtime and configuration

- Node 24 LTS. `.nvmrc` = `24`. Dockerfile `node:24-slim`.
- `config.ts` parses `process.env` with Zod at startup and exits with a readable error listing missing/invalid variables. Required variables and defaults are documented in `docs/ENVIRONMENT.md` (you create it). Minimum set:
  `NODE_ENV, APP_URL, APP_DOMAIN, DATABASE_URL, DATABASE_ADMIN_URL, SESSION_SECRET, DATA_ENCRYPTION_KEYS (JSON {kid: base64 32-byte key}), DATA_ENCRYPTION_ACTIVE_KID, S3_ENDPOINT, S3_REGION, S3_BUCKET, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY, STRIPE_SECRET_KEY, STRIPE_PUBLISHABLE_KEY, STRIPE_WEBHOOK_SECRET, STRIPE_CONNECT_WEBHOOK_SECRET, RESEND_API_KEY, MAIL_FROM, RESEND_WEBHOOK_SECRET, TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_MESSAGING_SERVICE_SID, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT, TURNSTILE_SITE_KEY, TURNSTILE_SECRET_KEY, CHECKR_API_KEY (optional), SENTRY_DSN (optional), AI_PROVIDER (none|anthropic, default none), ANTHROPIC_API_KEY (optional), AI_MODEL (default claude-sonnet-5), LEGAL_DOCS_APPROVED (production must be true), LOG_LEVEL, DELIVERY_MODE (preview|live)`.
- `DELIVERY_MODE=preview` (default outside production) routes email to Mailpit and SMS/push to the in-app preview outbox. Production refuses to start with `preview` unless `ALLOW_PREVIEW_DELIVERY_IN_PRODUCTION=true` (staging only).
- Production refuses to start if Stripe key is a live key while `APP_URL` is not HTTPS, if `SESSION_SECRET` is shorter than 32 bytes, or if encryption keys are missing.

## 3. Database

- PostgreSQL 16+. Extensions: `citext`, `pgcrypto`, `btree_gist` (exclusion constraints for space bookings), `pg_trgm` (search).
- IDs: UUIDv7 generated in the application (`uuid` package `v7`). Human-facing sequential numbers (invoice #, order #, receipt #) are per-org, allocated from `org_counters` with `UPDATE ... RETURNING` inside the transaction.
- Types: money = `bigint` cents (configure `pg` to parse int8 as JS number and assert `Number.isSafeInteger`); timestamps = `timestamptz`; calendar dates = `date`; enumerations = `text` + `CHECK` (not Postgres enums, which are painful to migrate); flexible configuration = `jsonb` validated by a Zod schema in `shared/` on every write and read.
- Migrations: SQL files in `db/migrations`, applied by `server/src/db/migrate.ts` in order, each in its own transaction, recorded in `schema_migrations(version, name, checksum, applied_at)`, guarded by `pg_advisory_lock`. A changed checksum of an applied migration is a startup error. Forward-only; no down migrations. After migrating, run `kysely-codegen` to regenerate `server/src/db/types.ts` (committed).
- Two roles: `athlentry_app` (used by web and worker, **no** `BYPASSRLS`) and `athlentry_admin` (migrations, platform-staff tools and explicitly privileged federation reads). `DATABASE_URL` uses the app role; `DATABASE_ADMIN_URL` the admin role.
- **Tenancy and RLS.** Every tenant-owned table has `org_id uuid NOT NULL REFERENCES organizations(id)` and RLS enabled with policy `USING (org_id = current_setting('app.org_id', true)::uuid) WITH CHECK (same)`. All tenant work runs through:

  ```ts
  withOrg(ctx: { orgId: string; actor: Actor }, fn: (trx) => Promise<T>): Promise<T>
  // BEGIN; SET LOCAL app.org_id = $1; SET LOCAL app.actor_id = $2; ...fn...; COMMIT
  ```
  Global tables (`accounts`, `sessions`, `sport_templates`, `platform_*`) have no org RLS; they are only reachable through their own modules. A CI test enumerates every table with an `org_id` column and fails if RLS is not enabled and forced (`ALTER TABLE ... FORCE ROW LEVEL SECURITY`).
- Transactions use `SERIALIZABLE` only where specified (capacity, money allocation); default `READ COMMITTED` with explicit `SELECT ... FOR UPDATE` on the rows being guarded.
- Full-text/people search: `pg_trgm` GIN index on a generated `search_text` column (names, emails, phones).

## 4. Identity, sessions and authentication

- `accounts` are global humans with email (citext unique), password hash, verification and MFA. People records (`people`) are per-org profiles; an account links to people through `person_account_links` (self or guardian).
- Password hashing: Argon2id via `@node-rs/argon2` (m=19456 KiB, t=2, p=1). Minimum length 10, maximum 256, reject the 10k most common passwords (bundle list), no composition rules.
- Sign-in methods: email+password; email magic link (15-minute, one-use); invitation acceptance. MFA: TOTP (RFC 6238) with 10 single-use recovery codes. **MFA is mandatory** for any account holding owner, admin or finance role in any org and for platform staff; enforced at sign-in and when such a role is granted (grant is pending until the grantee enrolls).
- Sessions: opaque 256-bit tokens, stored hashed (SHA-256) in `sessions`. Web uses cookie `__Host-athlentry_session` (`HttpOnly; Secure; SameSite=Lax; Path=/`). Native clients (future iOS) use `Authorization: Bearer <token>` issued by `POST /api/v1/auth/token` with `client: "ios"`; bearer sessions are listed and revocable like cookie sessions.
- Lifetimes: family/member sessions 30-day absolute, 14-day idle. Sessions with an elevated role: 12-hour idle, 7-day absolute. **Step-up re-authentication** (password or TOTP within the last 15 minutes) is required for: changing roles, payout/Stripe settings, issuing refunds above $500, exporting data containing Sensitive or Restricted tiers (see `04`), impersonation, deleting/anonymizing people, changing MFA.
- Password change, MFA change, role removal and account deactivation revoke all other sessions.
- CSRF: keep the existing double defense — state-changing requests require header `X-Athlentry-Request: 1` and a same-origin `Origin` (or no Origin for bearer clients). SameSite=Lax cookies.
- Rate limits (Postgres-backed `rate-limiter-flexible`): sign-in 8/15 min per IP+email, magic link and recovery 5/hour per email and 30/hour per IP, public form submissions 20/hour per IP, checkout creation 30/10 min per account. Public auth responses never disclose whether an account exists.
- Turnstile (Cloudflare) on public sign-up, public contact forms, donation forms and guest-accessible registration start. Verified server-side.

## 5. API conventions

- Base path `/api/v1`. Scopes:
  - `/api/v1/auth/*`, `/api/v1/me/*` (account-level: profile, linked people across orgs, payment methods, notifications, devices, sessions)
  - `/api/v1/orgs/:orgId/*` (everything tenant-scoped; the org must be one the actor has a membership or person link in, and the route's policy decides further)
  - `/api/v1/public/orgs/:slug/*` (no auth: website pages, program catalog, schedules/standings marked public, donation pages)
  - `/api/v1/platform/*` (platform staff only)
  - `/api/v1/webhooks/{stripe,stripe-connect,resend,twilio,checkr}` (signature-verified, raw body)
  - `/api/v1/stream` (SSE: notifications, chat, live scores for the authenticated account)
- Every request and response body is defined by a Zod schema in `shared/src/schemas`. OpenAPI 3.1 is generated from these schemas (`zod-openapi`) into `docs/api/openapi.json` by `npm run openapi`; CI fails if the committed file is stale.
- Errors: `{ "error": { "code": "REGISTRATION_CLOSED", "message": "human readable", "fields": { "path": "message" } } }` with status 400 validation, 401 unauthenticated, 403 forbidden, 404 not found (also used for other-tenant IDs — never 403, to avoid existence leaks), 409 conflict/stale, 422 business-rule violation, 429 rate limit, 503 dependency unavailable. Error codes are a closed enum in `shared/src/schemas/errors.ts`.
- Pagination: cursor-based `?cursor=&limit=` (default 50, max 200) returning `{ items, nextCursor }`. Sorting by allow-listed fields only.
- Idempotency: every POST that creates money movement, registrations, orders, invitations or messages requires `Idempotency-Key` (UUID). Stored in `idempotency_keys(org_id, actor_id, key, request_hash, response_status, response_body, created_at)` for 24 h. Same key + same hash → replay stored response; same key + different hash → 409.
- Optimistic concurrency: mutable aggregates carry `version int`. Updates send `expectedVersion`; mismatch → 409 with the current resource.
- Dates in JSON: ISO 8601 with offset for instants; `YYYY-MM-DD` for dates; money as integer cents with `currency`.

## 6. Background jobs (pg-boss)

`worker.ts` runs all queues. Jobs are idempotent (safe to re-run) and record outcomes. Required queues/schedules (add more as phases require):

| Queue | Trigger | Purpose |
|---|---|---|
| `checkout.expire` | every minute | release expired capacity holds and abandoned checkout sessions |
| `installments.charge` | every 15 min | charge due autopay installments (see `20-ALGORITHMS.md` dunning) |
| `installments.remind` | daily 14:00 org-local | upcoming-due and past-due reminders |
| `stripe.event` | webhook enqueue | process verified Stripe events |
| `messages.send` | on enqueue | fan out a message to recipient deliveries |
| `deliveries.send` | on enqueue, per recipient-channel | send via provider with retry/backoff |
| `notifications.dispatch` | on domain event | turn domain events into notifications by preference |
| `credentials.expiry` | daily | mark expired credentials, send 30/14/3-day reminders, recompute compliance |
| `waitlist.offers` | every 5 min | expire offers, advance queue |
| `schedule.generate` | on request | run schedule generator with time budget |
| `teams.balance` | on request | run team balancer |
| `reports.scheduled` | hourly | deliver scheduled reports |
| `exports.build` | on request | build org data exports (zip to storage, 7-day signed link) |
| `imports.process` | on request | validate/commit import batches |
| `classes.tuition` | daily | generate monthly tuition invoices / charges |
| `closures.notify` | on enqueue | notify everyone affected by a closure/cancellation |
| `retention.sweep` | weekly | apply retention policy |
| `search.reindex` | on demand | rebuild search text |

## 7. Files

- Private S3-compatible bucket. Uploads: client requests `POST /files/uploads` with purpose, mime and size → server validates (allow-list per purpose: images jpg/png/webp/heic ≤ 15 MB; documents pdf/jpg/png ≤ 15 MB; imports csv/xlsx ≤ 20 MB) and returns a presigned PUT with content-length/content-type conditions → client uploads → `POST /files/uploads/:id/complete` → server verifies object size/type (magic bytes), and for images re-encodes with `sharp` to WebP/JPEG, **stripping all EXIF/GPS metadata**, generating 3 sizes.
- Downloads: short-lived (5 minute) presigned GET URLs issued after a permission check; `Content-Disposition: attachment` for documents. Never public-read except published website assets, which are copied to a `public/` prefix only when published.
- `files(id, org_id nullable, purpose, owner refs, storage_key, mime, bytes, sha256, width, height, sensitivity tier, created_by, created_at, deleted_at)`.

## 8. Integrations (all behind interfaces with fake implementations for tests)

- `PaymentsGateway` (Stripe): accounts, onboarding links, customers, setup intents, payment intents, refunds, transfers reversal, disputes evidence, payouts listing, balance transactions, Billing subscriptions for platform plans, Apple Pay domain registration.
- `EmailSender` (Resend | Mailpit SMTP | Fake), `SmsSender` (Twilio | Preview | Fake), `PushSender` (web-push | Preview | Fake; APNs/FCM interfaces declared, not implemented).
- `BackgroundCheckProvider` (Manual | Checkr | Fake).
- `Storage` (S3 | local filesystem for dev | Memory for tests).
- `Captcha` (Turnstile | AlwaysPass for tests).
- `Geocoder` (optional; Nominatim-compatible HTTP or none) used only for facility maps/distance; the app works without it.
- `Clock` and `Random` injected so tests control time (installments, expiries) and generator seeds.

## 9. Security baseline

- `helmet` with a strict CSP: `default-src 'self'; script-src 'self' https://js.stripe.com https://challenges.cloudflare.com; frame-src https://js.stripe.com https://hooks.stripe.com https://challenges.cloudflare.com; connect-src 'self' https://api.stripe.com; img-src 'self' data: blob: <storage public origin>; style-src 'self' 'unsafe-inline'` (inline styles only if unavoidable; prefer none). HSTS 1 year in production. `X-Frame-Options: DENY` except the embeddable widget routes (`/embed/*`) which set `frame-ancestors *`.
- Field-level encryption (AES-256-GCM, key id prefix, random 96-bit nonce) for Restricted-tier columns: medical details, insurance policy numbers, custody notes, TOTP secrets, background-check result details, incident narratives. Encrypted columns are `bytea` named `*_enc`. Key rotation script re-encrypts in batches.
- Audit log for every write of Sensitive/Restricted data and every read of Restricted data (see `04`).
- Output: React escapes by default; rich text is sanitized server-side on write with the existing `sanitize-html` policy and rendered with `DOMPurify` on read. CSV exports use formula-injection escaping.
- Dependencies: `npm audit --omit=dev` must report no high/critical at phase gates; Renovate/Dependabot config committed.
- Secrets never logged: pino redaction paths for `authorization`, `cookie`, `password*`, `token*`, `*_enc`, card/bank fields, `ssn`, `dob` in logs.

## 10. Observability and operations

- pino JSON logs with `requestId`, `orgId`, `actorId` (ids only, never names/emails). Request logging with duration and status.
- Sentry (server + web) when `SENTRY_DSN` set; scrub PII via `beforeSend`.
- `GET /healthz` (process up), `GET /readyz` (DB reachable, migrations current, storage reachable, worker heartbeat < 2 min).
- Worker heartbeat row updated every 30 s; platform console shows queue depth, failed jobs, last webhook received per provider.
- Graceful shutdown: stop accepting, drain in-flight requests (30 s), stop pg-boss gracefully.

## 11. Frontend architecture

- Vite SPA with route-level code splitting (`React.lazy`) per area: `auth`, `console`, `portal`, `site`, `platform`. Main bundle budget 200 KB gzip; each area chunk ≤ 250 KB gzip (CI check with `size-limit`).
- React Router 7 data routers. TanStack Query for all server state (no ad-hoc `useEffect` fetching). Query keys namespaced by org id. Mutations never auto-retry.
- Forms: react-hook-form + `@hookform/resolvers/zod` using the shared schemas so client and server validate identically.
- Design system in `web/src/ui`, following **§11a** (unchanged visual design): tokens (color, spacing, radius, type scale, elevation) as CSS custom properties in `tokens.css`, light theme only, values copied from the existing CSS; components: Button, IconButton, Link, Field, Input, Textarea, Select, Combobox (async search), Checkbox, Radio, Switch, DateInput, TimeInput, DateRangeInput, MoneyInput, PhoneInput, FileUpload, Avatar, Badge, Tag, Card, Table (sortable, selectable, sticky header, responsive card mode under 640px), DataList, Tabs, Stepper, Dialog, Drawer, Sheet (mobile bottom sheet), Toast, Banner, EmptyState, ErrorState, Skeleton, Pagination, Calendar (month/week/day/agenda), Timeline, StatTile, Chart (use `recharts`), RichTextEditor (TipTap with the sanitize allow-list), SignaturePad, QRCode, PrintLayout.
- i18n: `react-i18next`, namespaces per area, English and Spanish complete for `auth`, `portal`, `site`, emails, SMS and push. Console strings are externalized in English with Spanish provided for all portal-shared components. No string concatenation for sentences; ICU plurals.
- Accessibility: WCAG 2.2 AA. All components keyboard-operable with visible focus; dialogs trap focus and restore it; touch targets ≥ 44×44 px; color contrast ≥ 4.5:1; `prefers-reduced-motion` respected; form errors announced via `aria-live` and linked with `aria-describedby`. `@axe-core/playwright` runs on every e2e page visit and fails on serious/critical issues.
- PWA: `vite-plugin-pwa` manifest (name, icons, theme), service worker that caches the app shell and static assets only; Web Push subscription; **Coach Game-Day offline mode** caches only the rosters, emergency contacts and allergy flags of teams the coach staffs for events within the next 24 hours, encrypted with a per-session key held in memory+IndexedDB and wiped on sign-out or after 24 h. Attendance/score entries made offline queue in IndexedDB and sync with idempotency keys when online, surfacing conflicts.
## 11a. Design system preservation (mandatory, decision D19)

The owner custom-redesigned the current UI. **The rebuild keeps that design system exactly.** Structure, navigation content and features change; the look does not.

**Source of truth** (read before writing any UI): `legacy/web/styles.css`, `legacy/web/admin-platform.css`, `legacy/web/landing.css`, `legacy/web/components.tsx`, `legacy/web/navigation.ts` (menu layout, not its LeagueApps item names), fonts in `public/landing/fonts`. Before Phase 0 moves them, these are `src/styles.css`, `src/admin-platform.css`, `src/landing.css`, `src/components.tsx`, `src/navigation.ts`. `docs/mockups/*.html` are old explorations, not the source of truth.

**Rules**
1. **Tokens verbatim.** Extract every custom property and recurring literal value from the legacy CSS into `web/src/ui/tokens.css`, keeping existing names (`--accent`, `--accent-600`, `--accent-050`, `--ok`, `--warn`, `--bad`, `--chrome*`, `--ink`, `--ink-2`, `--line`, `--canvas`, `--panel`, `--border`, `--muted`, `--site-primary`, …) and values. Recurring hard-coded values (radii, shadows, font sizes, spacing, control heights including 44px touch targets) become tokens with their existing values. No new colors, re-tuned grays or new spacing scale.
2. **Fonts unchanged.** Keep existing families and roles (Open Sans for app UI; Barlow Semi Condensed, DM Sans and Georgia where the legacy CSS uses them). Self-hosted. No new typefaces.
3. **Light theme only.** The current design has no dark mode; do not add one.
4. **Components keep their appearance.** Port legacy components (buttons, fields, selects, tables, modals, tabs, badges, status pills, cards, page headers, workspace kickers, header/sidebar chrome, program status chips, empty states) so they render the same: sizes, colors, borders, radii, shadows, hover/focus/active/disabled states, responsive behavior.
5. **New components derive from existing ones.** Components with no legacy equivalent (resource calendar, drag-and-drop boards, bracket view, chat, stepper, charts, signature pad, bottom sheet) use only the tokens and match the nearest existing component's radii, borders, typography, accent usage and density. Chart colors come from the existing palette.
6. **Layout shell unchanged.** Keep the current dark chrome header, org name area, menu pattern, dashboard card/table styling and workspace page headers. Navigation *items* follow `05-UX-AND-NAVIGATION.md §3`; their *presentation* follows the legacy shell. The mobile bottom tab bar uses the chrome tokens.
7. **Public org sites and marketing site** keep the current website/landing look (per-org `--site-primary`/`--site-secondary` branding, existing landing page design).
8. **No CSS framework or styled component library.** No Tailwind, Bootstrap, MUI, Chakra, Mantine, shadcn/ui, Radix Themes or similar. Behavior-only headless libraries (`@floating-ui/react`, `@dnd-kit`) are allowed if they add no styles.
9. **Accessibility fixes are the only allowed visual changes**, only where a legacy value fails WCAG 2.2 AA (contrast < 4.5:1, missing focus ring). Smallest passing change, same hue, logged in `DECISIONS.md`.
10. **Verification.** In Phase 1, before building UI, run the legacy app (a `git worktree` at the pre-rebuild commit `9ef77bb` if needed) and capture Playwright reference screenshots into `e2e/visual-reference/`: sign-in, dashboard, program list, program editor, members list, team profile, invoice detail, schedule, website editor, member portal home, public site home and one open modal, at 1440px and 390px. Copy the legacy token values into `e2e/visual-reference/tokens.json`. The rebuilt shell and shared components are compared against these with screenshot assertions; differences beyond anti-aliasing tolerance fail CI unless justified in `DECISIONS.md`.

- Org switching: the console route prefix is `/o/:orgSlug/...`; the portal is `/me/...` (cross-org) with org context chips. Account menu lists every org the account belongs to.
