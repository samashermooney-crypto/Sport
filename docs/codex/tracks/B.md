# Track B — sport logic and policies

Status: blocked
Model: GPT-6 Sol
Branch: `track/b-logic`
Current: Second queue implementation complete locally; integration hooks and OpenAPI freshness remain.
Ready: Age/eligibility — `shared/src/sport/{age,eligibility}.ts`; 11 targeted tests, typecheck and lint green.
Ready: Recurrence — `shared/src/recurrence.ts`; 11 targeted tests across four timezones, typecheck and lint green.
Ready: Sport schema/results/stats/standings — 19 targeted tests, typecheck and lint green; template goldens still pending.
Ready: Pricing/fees — `shared/src/algorithms/{pricing,fees}.ts`; 11 targeted tests, typecheck and lint green.
Ready: Installments/invoice-state/capacity-math — 13 targeted tests, typecheck and lint green.
Ready: Pure policies (compliance, SafeSport, refunds, quiet hours, FCRA) — 15 targeted tests, typecheck and lint green.
Ready: Brackets — single/double elimination, byes, pool seeding and guarded advancement; 5 targeted tests, typecheck and lint green.
Ready: Schedule generator — circle pairings, 15-minute slots, hard/soft constraints, seeded local search and tournament reservations; 7 targeted tests, typecheck and lint green.
Ready: Team balancer — fixed groups, mutual friends, siblings, position coverage, snake draft and seeded swaps; 4 targeted tests, typecheck and lint green.
Ready: Evaluation — evaluator normalization, weighted criteria, group ranks and incomplete flags; 5 targeted tests, typecheck and lint green.
Ready: Proration — joining, withdrawal, tier changes and pauses by scheduled sessions; 6 targeted tests, typecheck and lint green.
Ready: Dunning/waitlist — local 10:00 retries, nonretryable stops, quiet-hour offers and capacity holds; 6 targeted tests, typecheck and lint green.
Ready: Logic edge review — refund rule validation and date parsing; bracket, finance, policy, recurrence, age and stat boundary tests.
Ready: Scoring variants — swim relay points, diving difficulty, cross-country/golf team totals, rugby bonuses and cricket net run rate; 46 golden files checked.
Ready: Property invariants — brackets, capacity, schedule, dunning, waitlist, evaluation, sport engine and all five policies.
Ready: Phase 1 task 10 core — pg-boss schema, executable job descriptors, 30-second worker heartbeat and redacted failed-job listing; isolated Postgres job completed.
Ready: Phase 1 task 15 — OpenAPI 3.1 for 31 current operations with route coverage/freshness check; closed error schema on auth/orgs, cursor pagination, transactional Idempotency-Key and version checks.
Ready: Phase 1 task 14 — append-only audit service, fail-closed Restricted-field redaction/read helper, role-scoped cursor API and functional console viewer.
Ready: Phase 1 task 13 core — code-defined catalog, org-scoped inbox and preferences APIs, audited writes, Postgres LISTEN/NOTIFY SSE transport, and portal notification center; 5 targeted server tests pass.
Ready: Phase 1 task 9 core — global platform staff/flags/impersonation/audit schema, org and plan controls, read-only 60-minute impersonation service, health API, functional `/platform` console and hidden-password bootstrap script; 5 targeted Postgres and 2 web tests pass.
Ready for integration: 2693ff1..727cfe9 — second-queue tasks 10 jobs core, 15 API conventions and 14 audit; complete logic queue `30a775f..5c01024` is already on trunk.
Second queue implemented locally: 8cbbd56..HEAD — task 13 notifications and task 9 platform console, including schema, services, APIs, UI, bootstrap script and privacy/security hardening; formal readiness awaits the listed cross-track hooks and OpenAPI freshness.
Requests to other tracks: A — call `startRegisteredWorker(serverModules, DATABASE_URL)` from `server/src/worker.ts` and await `stop()` on signals; mount exported `auditConsoleRoutes` from `web/src/console/audit/routes.tsx`; mount notification module's `streamRouter` at `/api/v1/stream` through the generated registry and `notificationPortalRoutes` in portal routing.
Requests to other tracks: A — wire `auditImpersonatedRequest` from `server/src/modules/platform/impersonation.ts` into every impersonated tenant request, enforce read-only and 60-minute expiry, carry impersonation ID into tenant audits, show `ImpersonationBanner` across tenant views, include platform staff in sign-in MFA enforcement, and reject org operations when status is suspended.
Requests to other tracks: A — map notification inbox/preferences aliases under the account/organization API scope in `01 §5` when mounting the new module; generated registry currently mounts `/api/v1/notifications/orgs/:orgId/*`.
Requests to other tracks: A/C — add shared Zod request/response schemas and module OpenAPI descriptors for five existing files routes; the route-coverage generator now detects these undocumented operations, so `npm run openapi` currently fails after the spine merge.
Blocked on: A-owned worker, stream, console/portal and impersonation/auth/status hooks; shared files schemas for OpenAPI freshness and affected Playwright route coverage.
Self-review: Checked age and eligibility against `03 §3` and `15 §C8`; date rules reuse `shared/src/dates.ts`.
Self-review: Checked recurrence DST behavior against `15 §C1` across Chicago, New York, Phoenix and Honolulu.
Self-review: Checked money sequencing and state invariants against `20 §1–§5`; all arithmetic uses integer cents.
Self-review: Checked safety policies against `04 §4–§5`, refunds against Phase 5 task 7, and quiet hours against Phase 10.
Self-review: Initial logic suite, typecheck, lint and build green; first queue had no screens or routes requiring Playwright.
Self-review: 220 shared tests pass; Track B line coverage 95.08%; swim/diving/cross-country/golf/rugby/cricket variants checked against `03 §2, §5–§6`.
Self-review: Task 10 checked against `01 §6, §10`; pg-boss 12.1.1 migration applied and probe completed on isolated Postgres; generated registry refreshed.
Self-review: Task 15 checked against `01 §5` and Phase 1 task 15; concurrent idempotency replay tested on Postgres, existing auth/org routes and OpenAPI regeneration pass.
Self-review: Task 14 checked against `04 §6`; Restricted values are redacted at append and view, Restricted reads write in the read transaction, and owner/compliance/outsider access was tested on Postgres.
Self-review: Task 13 checked against `01 §5` and Phase 1 task 13; account-filtered SSE envelopes omit content, notifications and preferences use spine tables under `withOrg`, and concurrent preference updates serialize per account/category.
Self-review: Marketing notification preferences default disabled until explicit opt-in; operational and emergency preferences retain an enabled channel.
Self-review: Notification SSE revalidates its session on every 20-second heartbeat, ignores malformed envelopes and reloads the inbox on reconnect.
Self-review: Task 9 checked against Phase 1 task 9; platform writes use admin role where app grants are revoked, plan and org changes carry versions, last active super admin is protected, and impersonation requests log IDs without record payloads.
Self-review: Full unit/integration suite passes (370 tests, 1 existing skip); typecheck, lint and build pass; registry and DB types regenerated, OpenAPI freshness waits for C-owned files route schemas.
