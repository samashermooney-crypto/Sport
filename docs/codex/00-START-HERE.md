# 00 — Start Here

## 1. Mission

Turn this repository from a LeagueApps-shaped single-organization prototype into a production-ready, multi-tenant, sport-agnostic sports management platform that an administrator of any sport would choose over PlayMetrics, SportsEngine, LeagueApps, TeamSnap, Jackrabbit or iClassPro.

"Sport-agnostic" is not a dropdown of sport names. It means the platform understands the three operating models every sports organization is a mix of, and a sport-profile layer that tells the platform how a given sport is structured and scored:

| Operating model | Who | Core loop |
|---|---|---|
| **League / competition** | Rec leagues (Little League, AYSO-style), adult rec, school-age leagues, parks & rec | Season → registration → divisions → team formation → schedule → games → standings |
| **Club** | Competitive/travel clubs (soccer, volleyball, hockey, baseball, lacrosse, basketball) | Persistent teams across years → tryouts/evaluations → offers & deposits → team fees → governing-body carding → compliance → tournaments |
| **Academy / class** | Gymnastics, swim schools, martial arts, dance, cheer, tennis, skating | Recurring class sessions → monthly/term tuition → skill levels → make-ups → progression |

Plus two cross-cutting modes: **tournaments/events** (brackets, external team entry) and **federation** (an association or league with member clubs).

## 2. Who we are building for (design every screen against these people)

1. **Dana — volunteer rec-league president.** Full-time job, does league work 8–11pm on a laptop or phone. 600 kids, 45 volunteer coaches, 6 fields borrowed from the city. Needs: copy last season, open registration, chase unpaid families and missing background checks, build a fair schedule, handle rainouts in one tap, keep the board informed. Pain: setup complexity, reports that do not answer questions, parents emailing "what time is the game?".
2. **Marcus — club director of operations.** Paid staff, 40 travel teams, 700 players, year-round. Needs: tryouts with evaluator scoring, team placement, offers with deposits, team fee payment plans with autopay, coach licensing and SafeSport compliance, governing-body IDs, field allocation across 3 complexes, tournament travel, team treasurer oversight, financial reconciliation.
3. **Priya — gymnastics/swim academy owner.** 900 students in weekly classes, monthly tuition, skill levels, make-up classes, trial classes, staff ratios, family discounts. Currently on Jackrabbit/iClassPro.
4. **Coach Tom — volunteer coach.** On a phone at the field. Needs: roster with emergency contacts and allergies, attendance, lineup/playing time, score entry, team messaging that is SafeSport-compliant.
5. **Jen — parent of three kids in two organizations.** One login, one card on file, one calendar, fast re-registration, clear balances, Spanish if needed.
6. **Ref Luis — official.** Sees assignments, accepts games, submits game reports, sees what he is owed.
7. **Karen — state association registrar.** Oversees 60 member clubs: team entries, player/coach eligibility, compliance status, league scheduling, discipline.
8. **Platform staff (us).** Onboard orgs, support them safely (audited impersonation), manage plans and fees, watch system health.

## 3. Definition of done (the whole project)

The platform is done when all of the following are true, verified by automated tests and documented evidence in `PROGRESS.md`:

1. Every phase in `10`–`13` is complete with its acceptance criteria met.
2. An organization can self-sign-up, connect Stripe (test mode), configure a season from a sport template, open registration, take real card/ACH payments (test mode) including autopay installments, refunds and disputes, form teams, pass compliance gating, generate and publish a schedule, run game day, compute standings/brackets, communicate over email/SMS/push/in-app, and close the season with reports — entirely through the UI, on desktop and on a 390px-wide phone.
3. All three operating models plus tournaments and federation have at least one seeded demo org exercising every feature.
4. Security, privacy, accessibility (WCAG 2.2 AA), performance and operability requirements in `13-PHASE-PRODUCTION.md` pass.
5. The API is fully described by a generated OpenAPI document and usable with bearer tokens (for the future iOS app).
6. `40-OPERATOR-CHECKLIST.md` lists every remaining step that requires a human with credentials or legal authority, and nothing else is left.

## 4. Honest boundary: what you cannot finish alone

Some launch steps need the owner's accounts, money, signatures or lawyers. You MUST build the software for these fully (adapters, configuration, admin screens, test-mode verification) and document the human step in `40-OPERATOR-CHECKLIST.md`. You MUST NOT fake them, stub them silently, or claim they are live:

- Stripe live-mode activation, Connect platform profile approval, Apple Pay domain verification on production domains.
- Email sending domain DNS (SPF/DKIM/DMARC) and Resend production key.
- Twilio A2P 10DLC brand/campaign registration (US SMS will be filtered without it).
- Background-check vendor partnership (Checkr requires an approved account).
- Production hosting, domain, TLS, backups/PITR, Sentry project.
- Legal documents (Terms, Privacy Policy, DPA, cookie notice, refund policy template) reviewed by a lawyer. You provide clearly marked drafts and the in-product consent capture.
- Penetration test and third-party accessibility audit.

## 5. Decisions already made (do not re-open; log refinements in DECISIONS.md)

| # | Decision |
|---|---|
| D1 | Product name **Athlentry**. Replace every `fieldhouse`/`Fieldhouse` identifier (cookie names, headers, DB names, copy) with `athlentry`/`Athlentry`. |
| D2 | Market at launch: United States, USD, English and Spanish. Store `currency` and `locale` on org/account so expansion is a configuration change, but do not build multi-currency conversion. |
| D3 | Stack: Node.js 24 LTS, TypeScript strict everywhere (server, web, shared), Express 5, Zod 4, React 19, React Router 7, TanStack Query 5, react-hook-form, Vite 7. PostgreSQL 16+, Kysely query builder with generated types, SQL-file migrations. pg-boss for jobs (no Redis). S3-compatible object storage. Vitest + Playwright. |
| D4 | The old SQLite code is **reference only**. New schema is designed from `02-DATA-MODEL.md`. There is no production data to migrate; do not build a SQLite→Postgres data migrator. Demo data is regenerated by seed scripts. |
| D5 | Multi-tenant SaaS: one deployment serves many organizations. Global accounts (one login per human) with per-organization memberships and role assignments. Postgres Row-Level Security as defense in depth. |
| D6 | Payments: **Stripe Connect** with **Express** connected accounts, **destination charges** (`on_behalf_of` + `transfer_data.destination` + `application_fee_amount`). Customers and saved payment methods live on the platform account so one family card works across all orgs. Card, ACH (`us_bank_account` via Financial Connections), Apple Pay, Google Pay, Link through the Payment Element. PCI scope SAQ-A: card data never touches our servers. |
| D7 | Revenue: per-org application fee (basis points + fixed cents) configured through plans in the platform console, plus optional monthly subscription plans billed by Stripe Billing on the platform account. Seed defaults: plan "Starter" (no subscription, 150 bps + 0¢ application fee), plan "Pro" ($99/mo, 75 bps), plan "Enterprise" (custom). The owner will change numbers later; they are data, not code. |
| D8 | Families may be charged a **service fee** if the org enables pass-through. It MUST apply identically to every payment method (it is a service fee, not a card surcharge), MUST be shown as a separate line before payment, and MUST be refunded proportionally when the underlying item is refunded unless the org's published refund policy says otherwise. |
| D9 | Realtime (chat, live scores, notification badges) uses Server-Sent Events backed by Postgres `LISTEN/NOTIFY`. No WebSocket infrastructure. |
| D10 | Push notifications: Web Push (VAPID) now; the device-token model already supports `apns` and `fcm` for the future app. |
| D11 | Email: Resend adapter (existing), templates authored with React Email, delivery/bounce/complaint webhooks. SMS: Twilio Messaging Service with Advanced Opt-Out; inbound STOP/START/HELP webhook. Local dev uses Mailpit for email and a console/preview adapter for SMS/push. |
| D12 | Background checks: provider-adapter interface. The **manual** provider (compliance officer records result + uploads document) is first-class and fully functional. A **Checkr** adapter is implemented against Checkr's API and exercised with recorded fixtures; it is enabled per org only when platform credentials exist. |
| D13 | Accounts are only for people 13 or older (COPPA). Children under 13 are profiles managed by guardians. Athletes 13–17 may have an account linked to a guardian; guardians are always included in any message from an adult staff member to a minor (SafeSport MAAPP). |
| D14 | Hosting reference: Docker image; one `web` service, one `worker` service, managed Postgres 16 with point-in-time recovery, S3-compatible bucket (Cloudflare R2 or Supabase Storage via S3 API). A `render.yaml` blueprint is provided as the reference deployment; nothing may be hard-wired to a single vendor. |
| D15 | Org public websites are served at `https://{slug}.<APP_DOMAIN>` and `https://<APP_DOMAIN>/o/{slug}`. Custom domains: data model, verification (TXT record) and routing are built; TLS provisioning is an operator step documented for Cloudflare for SaaS. |
| D16 | No hard deletes of people, money, compliance, waivers, audit. Privacy deletion requests anonymize personal fields and retain financial/legal records per retention policy in `04`. |
| D17 | Competitor importers are **mapping-driven**. Do not invent SportsEngine/LeagueApps/TeamSnap/PlayMetrics column names. Build a generic importer with column mapping, validation preview, and saved mapping presets; presets for named competitors are added only from real export files the owner supplies later (document this). |
| D19 | **The design system stays the same.** The existing custom visual design (in `legacy/web/styles.css`, `legacy/web/admin-platform.css`, `legacy/web/landing.css`, `legacy/web/components.tsx`, fonts in `public/landing/fonts`) is the owner's final redesign. The rebuild changes structure, navigation content and functionality, not the look. See `01-ARCHITECTURE.md §11a`. `docs/mockups/*.html` are old explorations, not the source of truth; the shipped CSS is. |
| D18 | Out of scope for this project (document in README as "not included"): native mobile apps, livestream video, hotel/stay-to-play booking, QuickBooks API sync (CSV export is in scope), payroll, SSO/SAML, marketplace of third-party plugins, multi-currency, non-US tax handling, AI features beyond those listed in `12-PHASES-EXPANSION.md`. |

## 6. Working method

1. Work phases strictly in order: `10-PHASES-FOUNDATION.md` (Phases 0–2) → `11-PHASES-OPERATIONS.md` (Phases 3–9) → `12-PHASES-EXPANSION.md` (Phases 10–15) → `13-PHASE-PRODUCTION.md` (Phase 16). Later phases depend on earlier data models.
2. At the start of each phase, copy its task list into `PROGRESS.md` as checkboxes. Check items off only when implemented, tested and committed.
3. For each task: schema migration → shared Zod schemas → service with domain tests → routes with HTTP tests (including permission and tenancy tests) → UI → Playwright journey where the phase requires one → docs.
4. A phase gate passes only when every acceptance criterion in its section is demonstrably true and all commands in `AGENTS.md` pass. Record the evidence (test names, e2e specs) in `PROGRESS.md`.
5. If you discover the spec is wrong or contradictory, choose the safest correct behavior, implement it, and record it in `DECISIONS.md` with the reason. Never silently diverge.
6. Keep the app runnable at every commit. Never leave `main` broken.
7. When context runs short, write a precise "Next steps" block at the top of `PROGRESS.md` before stopping.

## 7. What to keep from the existing code

The existing code (moved to `legacy/` in Phase 0, deleted in Phase 16) contains carefully tested patterns. Port the **patterns**, not the schema:

- Transaction + audit on every write (`server/db.mjs` `transaction`, `audit`).
- Idempotency keys with request-hash comparison for creates that can be retried (`product_orders`, `registration_transfers`, `schedule_imports`, `tryouts`).
- Optimistic concurrency with `version`/`revision` columns and 409 on stale writes.
- Versioned waiver evidence: the exact document text/version accepted is stored immutably with signer, method and timestamps (`waiver_acceptances`).
- Versioned form definitions with answers stored alongside the definition version (`registration_answers`, `profile_answer_revisions`).
- Registration transfer/cancellation atomicity and "one active registration per person per program" (`registration-lifecycle.mjs`, `registration-migration.mjs`).
- Invitation/reset tokens: random, hashed at rest, expiring, one-use, rotated on resend, bound to org/email/role (`admin-users.mjs`, `member-invitations.mjs`).
- Public recovery responses that never reveal account existence; rate limits on public auth endpoints.
- CSV formula-injection protection (`src/api.ts` `csvCell`) and HTML sanitization (`server/html.mjs`).
- Schedule CSV import with preview, per-line issues and all-or-nothing accept (`schedule-import-mapping.mjs`).
- Schedule conflict detection for teams and related sub-locations (`server/domain.mjs` ~line 729, `schedule-time.mjs`).
- Standings configuration vocabulary (`server/standings.mjs`) — generalized in `03-SPORT-ENGINE.md`.
- Honest UX states: connection errors vs server errors, no automatic retry of writes, result lookup after an uncertain submission (`src/api.ts`, transfer result lookup).
- **Visual design system (mandatory, D19):** keep the current typography, color tokens, spacing, radii, shadows, chrome header/sidebar look and component appearance from `styles.css`/`admin-platform.css`/`landing.css`/`components.tsx` exactly. Consolidating them into `web/src/ui` is a refactor of *where* the styles live, never a change of *how things look*. The landing page (`src/landing.tsx`, `public/landing`) is kept and its copy updated in Phase 16 to claim only what exists.

Discard: LeagueApps navigation taxonomy ("Site Level Calendar", "Other Offerings", "Email Contacts"), `accounting_1..5` terminology fields (replaced by GL codes), grouped/sub-programs (replaced by divisions), the single-org `users` table, SQLite-specific code, the `settings` key/value dumping ground for anything that has a real model.

## 8. Handoff file map

| File | Contents |
|---|---|
| `01-ARCHITECTURE.md` | Repository layout, runtime, database access, tenancy/RLS, auth, API conventions, jobs, files, integrations, security, observability, frontend architecture |
| `02-DATA-MODEL.md` | Every table, key columns, constraints and invariants |
| `03-SPORT-ENGINE.md` | Sport profile schema, result formats, age-group methods, built-in sport templates |
| `04-PERMISSIONS-AND-PRIVACY.md` | Roles, scopes, permission matrix, data-sensitivity tiers, child-safety rules, retention |
| `05-UX-AND-NAVIGATION.md` | Information architecture, screen inventory, UX rules, action center, mobile rules |
| `10-PHASES-FOUNDATION.md` | Phases 0–2: tooling, platform core, identity, people |
| `11-PHASES-OPERATIONS.md` | Phases 3–9: sports/programs/teams, payments, registration, evaluations, compliance, scheduling, game day/results/tournaments/officials |
| `12-PHASES-EXPANSION.md` | Phases 10–15: communications, volunteers/team finance/fundraising/store, academy mode, federation, reporting/website, onboarding/import |
| `13-PHASE-PRODUCTION.md` | Phase 16: security, performance, accessibility, operations, deployment, launch gate |
| `20-ALGORITHMS.md` | Money math, capacity, waitlist, schedule generator, team balancing, standings/tiebreakers, brackets, evaluations, dunning, proration |
| `30-TESTING-AND-QUALITY.md` | Test architecture, required suites, Playwright journeys, coverage, fixtures |
| `40-OPERATOR-CHECKLIST.md` | Human-only launch steps (keep updated) |
| `PROGRESS.md` | Your live checklist |
| `DECISIONS.md` | Your decision log |
